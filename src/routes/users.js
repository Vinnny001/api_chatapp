import { Router } from 'express';
import { z } from 'zod';
import { Conversation, EVENTS, UPLOAD_URL_PATTERN, User, escapeRegex, publicUser } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToConversations } from '../realtime.js';
import { phoneVariants } from '../phone.js';

export const uploadUrl = z.string().regex(UPLOAD_URL_PATTERN, 'Invalid upload url');

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  about: z.string().trim().max(140).optional(),
  avatarUrl: uploadUrl.nullable().optional(),
  settings: z.object({ showLastSeen: z.boolean().optional() }).optional(),
});

const router = Router();

router.get(
  '/search',
  handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const digits = q.replace(/[\s()-]/g, '');
    const or = [{ name: new RegExp(escapeRegex(q), 'i') }, { email: q.toLowerCase() }];
    if (/^\+?\d{3,}$/.test(digits)) {
      or.push({ phone: new RegExp(escapeRegex(digits)) });
      // "0712..." should also find accounts stored as "+254712..." and vice versa.
      if (digits.length >= 9) or.push({ phone: { $in: phoneVariants(digits) } });
    }

    const users = await User.find({ _id: { $ne: req.userId }, $or: or }).sort({ name: 1 }).limit(20);
    res.json({ users: users.map((u) => publicUser(u)) });
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
    if (data.settings?.showLastSeen !== undefined) user.settings.showLastSeen = data.settings.showLastSeen;
    await user.save();

    const convIds = await Conversation.find({ 'participants.user': user._id }).distinct('_id');
    emitToConversations(convIds.map(String), EVENTS.USER_UPDATED, publicUser(user));
    res.json({ user: publicUser(user, { self: true }) });
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
