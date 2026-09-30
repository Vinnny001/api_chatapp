import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Conversation, EVENTS, UPLOAD_URL_PATTERN, USER_FIELDS, User, escapeRegex, publicUser } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToConversations } from '../realtime.js';
import { phoneVariants } from '../phone.js';
import { usernameSchema } from './auth.js';

export const uploadUrl = z.string().regex(UPLOAD_URL_PATTERN, 'Invalid upload url');

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  about: z.string().trim().max(140).optional(),
  avatarUrl: uploadUrl.nullable().optional(),
  username: usernameSchema.optional(),
  settings: z
    .object({
      showLastSeen: z.boolean().optional(),
      showPhone: z.boolean().optional(),
      showEmail: z.boolean().optional(),
    })
    .optional(),
});

const router = Router();

/**
 * Find people by username ("ali" or "@ali" finds @alice), by their full phone number, or by
 * email when they chose to share it. Registered names aren't searchable (they're private),
 * and a hidden number can't be discovered by typing part of it.
 */
router.get(
  '/search',
  handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const handleQ = q.replace(/^@/, '').toLowerCase();
    const digits = q.replace(/[\s()-]/g, '');
    const or = [];
    if (/^[a-z][a-z0-9._]{0,29}$/.test(handleQ)) or.push({ username: new RegExp(`^${escapeRegex(handleQ)}`) });
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) or.push({ email: q.toLowerCase(), 'settings.showEmail': true });
    const phones = /^\+?\d{9,}$/.test(digits) ? phoneVariants(digits) : [];
    if (phones.length) or.push({ phone: { $in: phones } });
    if (!or.length) return res.json({ users: [] });

    const users = await User.find({ _id: { $ne: req.userId }, $or: or }).sort({ username: 1 }).limit(20);
    // Someone who typed the full number already knows it.
    res.json({
      users: users.map((u) => ({ ...publicUser(u), ...(phones.includes(u.phone) && { phone: u.phone }) })),
    });
  })
);

const lookupSchema = z.object({ phones: z.array(z.string().max(40)).min(1).max(2000) });

/**
 * Which of these phone numbers (e.g. the user's address book, or a number tapped in a
 * chat) belong to registered users. Returns one entry per input number that matched.
 */
router.post(
  '/lookup',
  handle(async (req, res) => {
    const { phones } = lookupSchema.parse(req.body);
    const inputsByVariant = new Map();
    for (const input of phones) {
      for (const v of phoneVariants(input)) {
        if (!inputsByVariant.has(v)) inputsByVariant.set(v, []);
        inputsByVariant.get(v).push(input);
      }
    }
    if (!inputsByVariant.size) return res.json({ matches: [] });

    const users = await User.find({ phone: { $in: [...inputsByVariant.keys()] } });
    const matches = [];
    for (const u of users) {
      for (const input of new Set(inputsByVariant.get(u.phone))) {
        matches.push({ phone: input, self: String(u._id) === req.userId, user: publicUser(u) });
      }
    }
    res.json({ matches });
  })
);

const deviceSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios', 'web']).default('android'),
});

/** Registers this phone for push notifications (a token belongs to one account at a time). */
router.post(
  '/me/devices',
  handle(async (req, res) => {
    const { token, platform } = deviceSchema.parse(req.body);
    await User.updateMany({ 'devices.token': token }, { $pull: { devices: { token } } });
    await User.updateOne(
      { _id: req.userId },
      { $push: { devices: { $each: [{ token, platform, updatedAt: new Date() }], $slice: -10 } } }
    );
    res.status(201).json({ ok: true });
  })
);

/** Signing out on this phone: stop sending it notifications for this account. */
router.delete(
  '/me/devices/:token',
  handle(async (req, res) => {
    await User.updateOne({ _id: req.userId }, { $pull: { devices: { token: req.params.token } } });
    res.json({ ok: true });
  })
);

router.patch(
  '/me',
  handle(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(404, 'User not found');

    if (data.name !== undefined) user.name = data.name;
    if (data.about !== undefined) user.about = data.about;
    if (data.avatarUrl !== undefined) user.avatarUrl = data.avatarUrl;
    if (data.username !== undefined && data.username !== user.username) {
      if (await User.exists({ username: data.username, _id: { $ne: user._id } })) {
        throw new HttpError(409, 'That username is taken');
      }
      user.username = data.username;
    }
    for (const key of ['showLastSeen', 'showPhone', 'showEmail']) {
      if (data.settings?.[key] !== undefined) user.settings[key] = data.settings[key];
    }
    await user.save();

    const convIds = await Conversation.find({ 'participants.user': user._id }).distinct('_id');
    emitToConversations(convIds.map(String), EVENTS.USER_UPDATED, publicUser(user));
    res.json({ user: publicUser(user, { self: true }) });
  })
);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const contactSchema = z.object({ name: z.string().trim().max(60).default('') });

const contactOut = (c) => ({ user: publicUser(c.user), name: c.name || '', addedAt: c.addedAt });

/** My saved ChatApp contacts (kept on the server so they're the same on every device). */
router.get(
  '/me/contacts',
  handle(async (req, res) => {
    const me = await User.findById(req.userId, '+contacts').populate('contacts.user', USER_FIELDS);
    const contacts = (me?.contacts || []).filter((c) => c.user); // skip deleted accounts
    res.json({ contacts: contacts.map(contactOut) });
  })
);

/** Save someone (or rename them) in my contacts. */
router.put(
  '/me/contacts/:userId',
  handle(async (req, res) => {
    const userId = objectId.parse(req.params.userId);
    const { name } = contactSchema.parse(req.body || {});
    if (userId === req.userId) throw new HttpError(400, 'You cannot add yourself');
    const other = await User.findById(userId, USER_FIELDS);
    if (!other) throw new HttpError(404, 'User not found');
    const updated = await User.updateOne(
      { _id: req.userId, 'contacts.user': userId },
      { $set: { 'contacts.$.name': name } }
    );
    if (!updated.matchedCount) {
      await User.updateOne(
        { _id: req.userId },
        { $push: { contacts: { $each: [{ user: userId, name, addedAt: new Date() }], $slice: -5000 } } }
      );
    }
    res.json({ contact: contactOut({ user: other, name, addedAt: new Date() }) });
  })
);

router.delete(
  '/me/contacts/:userId',
  handle(async (req, res) => {
    const userId = objectId.parse(req.params.userId);
    await User.updateOne({ _id: req.userId }, { $pull: { contacts: { user: userId } } });
    res.json({ ok: true });
  })
);

router.get(
  '/:id',
  handle(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(404, 'User not found');
    res.json({ user: publicUser(user, { self: String(user._id) === req.userId }) });
  })
);

export default router;
