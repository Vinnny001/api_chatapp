import { Router } from 'express';
import { z } from 'zod';
import { Conversation, EVENTS, UPLOAD_URL_PATTERN, User, escapeRegex, publicUser } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToConversations } from '../realtime.js';

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
    if (/^\+?\d{3,}$/.test(digits)) or.push({ phone: new RegExp(escapeRegex(digits)) });

    const users = await User.find({ _id: { $ne: req.userId }, $or: or }).sort({ name: 1 }).limit(20);
    res.json({ users: users.map((u) => publicUser(u)) });
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
