import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  Conversation,
  EVENTS,
  Message,
  REPLY_POPULATE,
  User,
  canSend,
  createMessage,
  createSystemMessage,
  pushNewMessage,
  escapeRegex,
  findConversationForUser,
  sameId,
  serializeConversation,
  serializeMessage,
  withConversationRefs,
} from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { uploadUrl } from './users.js';
import {
  broadcastConversation,
  broadcastMessage,
  emitToUser,
  removeUserFromConversation,
} from '../realtime.js';

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

export const DISAPPEARING_OPTIONS = { 0: 'off', 3600: '1 hour', 86400: '24 hours', 604800: '7 days', 7776000: '90 days' };
const MAX_GROUP_SIZE = 512;

const groupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(80),
  description: z.string().trim().max(500).optional(),
  avatarUrl: uploadUrl.nullable().optional(),
  memberIds: z.array(objectId).min(1, 'Add at least one member').max(MAX_GROUP_SIZE - 1),
});

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  avatarUrl: uploadUrl.nullable().optional(),
  onlyAdminsCanSend: z.boolean().optional(),
  disappearingSeconds: z
    .number()
    .int()
    .refine((v) => v in DISAPPEARING_OPTIONS, 'Unsupported disappearing timer')
    .optional(),
});

const prefsSchema = z.object({
  pinned: z.boolean().optional(),
  muted: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const router = Router();

async function loadForUser(req) {
  const conv = await findConversationForUser(req.params.id, req.userId);
  if (!conv) throw new HttpError(404, 'Conversation not found');
  return conv;
}

function requireGroupAdmin(conv, userId) {
  if (conv.type !== 'group') throw new HttpError(400, 'Only groups support this');
  if (conv.member(userId)?.role !== 'admin') throw new HttpError(403, 'Only group admins can do that');
}

async function names(ids) {
  const users = await User.find({ _id: { $in: ids } }, 'name').lean();
  const byId = new Map(users.map((u) => [String(u._id), u.name]));
  return ids.map((id) => byId.get(String(id)) || 'Someone');
}

async function postSystem(conv, text) {
  const { message } = await createSystemMessage(conv, text);
  broadcastMessage(message, conv);
}

async function sendOwnView(conversationId, userId) {
  const conv = await withConversationRefs(Conversation.findById(conversationId));
  const view = serializeConversation(conv, userId);
  emitToUser(userId, EVENTS.CONVERSATION_UPSERT, view);
  return view;
}

router.get(
  '/',
  handle(async (req, res) => {
    const convs = await withConversationRefs(
      Conversation.find({ 'participants.user': req.userId }).sort({ lastMessageAt: -1 })
    );
    res.json({ conversations: convs.map((c) => serializeConversation(c, req.userId)) });
  })
);

router.get(
  '/:id',
  handle(async (req, res) => {
    const conv = await withConversationRefs(
      Conversation.findOne({ _id: req.params.id, 'participants.user': req.userId })
    );
    if (!conv) throw new HttpError(404, 'Conversation not found');
    res.json({ conversation: serializeConversation(conv, req.userId) });
  })
);

router.post(
  '/direct',
  handle(async (req, res) => {
    const { userId } = z.object({ userId: objectId }).parse(req.body);
    if (userId === req.userId) throw new HttpError(400, 'You cannot start a chat with yourself');
    if (!(await User.exists({ _id: userId }))) throw new HttpError(404, 'User not found');

    const directKey = [req.userId, userId].sort().join(':');
    let conv = await Conversation.findOne({ directKey });
    if (!conv) {
      try {
        conv = await Conversation.create({
          type: 'direct',
          directKey,
          createdBy: req.userId,
          participants: [{ user: req.userId }, { user: userId }],
        });
        await broadcastConversation(conv._id, { join: [req.userId, userId] });
      } catch (err) {
        if (err.code !== 11000) throw err;
        conv = await Conversation.findOne({ directKey }); // created concurrently
      }
    }
    const full = await withConversationRefs(Conversation.findById(conv._id));
    res.status(201).json({ conversation: serializeConversation(full, req.userId) });
  })
);

router.post(
  '/group',
  handle(async (req, res) => {
    const data = groupSchema.parse(req.body);
    const memberIds = [...new Set(data.memberIds)].filter((id) => id !== req.userId);
    const found = await User.countDocuments({ _id: { $in: memberIds } });
    if (found !== memberIds.length) throw new HttpError(400, 'Some members do not exist');

    const conv = await Conversation.create({
      type: 'group',
      name: data.name,
      description: data.description || '',
      avatarUrl: data.avatarUrl ?? null,
      createdBy: req.userId,
      participants: [
        { user: req.userId, role: 'admin' },
        ...memberIds.map((id) => ({ user: id })),
      ],
    });
    await broadcastConversation(conv._id, { join: [req.userId, ...memberIds] });
    const [creator] = await names([req.userId]);
    await postSystem(conv, `${creator} created group "${conv.name}"`);

    const full = await withConversationRefs(Conversation.findById(conv._id));
    res.status(201).json({ conversation: serializeConversation(full, req.userId) });
  })
);

router.patch(
  '/:id',
  handle(async (req, res) => {
    const data = settingsSchema.parse(req.body);
    const conv = await loadForUser(req);
    const [actor] = await names([req.userId]);
    const notes = [];

    const groupFields = ['name', 'description', 'avatarUrl', 'onlyAdminsCanSend'].filter(
      (k) => data[k] !== undefined
    );
    if (groupFields.length) requireGroupAdmin(conv, req.userId);
    if (data.disappearingSeconds !== undefined && conv.type === 'group') requireGroupAdmin(conv, req.userId);

    if (data.name !== undefined && data.name !== conv.name) {
      conv.name = data.name;
      notes.push(`${actor} changed the group name to "${data.name}"`);
    }
    if (data.description !== undefined && data.description !== conv.description) {
      conv.description = data.description;
      notes.push(`${actor} changed the group description`);
    }
    if (data.avatarUrl !== undefined && data.avatarUrl !== conv.avatarUrl) {
      conv.avatarUrl = data.avatarUrl;
      notes.push(`${actor} changed the group photo`);
    }
    if (data.onlyAdminsCanSend !== undefined && data.onlyAdminsCanSend !== conv.onlyAdminsCanSend) {
      conv.onlyAdminsCanSend = data.onlyAdminsCanSend;
      notes.push(
        data.onlyAdminsCanSend
          ? `${actor} changed settings so only admins can send messages`
          : `${actor} changed settings so all members can send messages`
      );
    }
    if (data.disappearingSeconds !== undefined && data.disappearingSeconds !== conv.disappearingSeconds) {
      conv.disappearingSeconds = data.disappearingSeconds;
      notes.push(
        data.disappearingSeconds
          ? `${actor} turned on disappearing messages. New messages will disappear after ${DISAPPEARING_OPTIONS[data.disappearingSeconds]}.`
          : `${actor} turned off disappearing messages`
      );
    }

    await conv.save();
    for (const note of notes) await postSystem(conv, note);
    await broadcastConversation(conv._id);
    const full = await withConversationRefs(Conversation.findById(conv._id));
    res.json({ conversation: serializeConversation(full, req.userId) });
  })
);

router.patch(
  '/:id/prefs',
  handle(async (req, res) => {
    const prefs = prefsSchema.parse(req.body);
    await loadForUser(req);
    const set = Object.fromEntries(Object.entries(prefs).map(([k, v]) => [`participants.$.${k}`, v]));
    await Conversation.updateOne({ _id: req.params.id, 'participants.user': req.userId }, { $set: set });
    res.json({ conversation: await sendOwnView(req.params.id, req.userId) });
  })
);

router.post(
  '/:id/clear',
  handle(async (req, res) => {
    await loadForUser(req);
    await Conversation.updateOne(
      { _id: req.params.id, 'participants.user': req.userId },
      { $set: { 'participants.$.clearedAt': new Date(), 'participants.$.unreadCount': 0 } }
    );
    res.json({ conversation: await sendOwnView(req.params.id, req.userId) });
  })
);

router.post(
  '/:id/members',
  handle(async (req, res) => {
    const { userIds } = z.object({ userIds: z.array(objectId).min(1).max(100) }).parse(req.body);
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);

    const newIds = [...new Set(userIds)].filter((id) => !conv.member(id));
    if (!newIds.length) throw new HttpError(400, 'Those users are already members');
    if (conv.participants.length + newIds.length > MAX_GROUP_SIZE) throw new HttpError(400, 'Group is full');
    if ((await User.countDocuments({ _id: { $in: newIds } })) !== newIds.length) {
      throw new HttpError(400, 'Some users do not exist');
    }

    const now = new Date();
    conv.participants.push(
      ...newIds.map((id) => ({ user: id, joinedAt: now, lastReadAt: now, lastDeliveredAt: now }))
    );
    await conv.save();

    const [actor, ...added] = await names([req.userId, ...newIds]);
    await postSystem(conv, `${actor} added ${added.join(', ')}`);
    await broadcastConversation(conv._id, { join: newIds });
    res.json({ ok: true });
  })
);

router.patch(
  '/:id/members/:userId',
  handle(async (req, res) => {
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(req.body);
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);
    const member = conv.member(req.params.userId);
    if (!member) throw new HttpError(404, 'Not a member');
    if (member.role === role) return res.json({ ok: true });
    if (role === 'member' && conv.participants.filter((p) => p.role === 'admin').length === 1) {
      throw new HttpError(400, 'A group needs at least one admin');
    }

    member.role = role;
    await conv.save();
    const [actor, target] = await names([req.userId, req.params.userId]);
    await postSystem(
      conv,
      role === 'admin' ? `${actor} made ${target} an admin` : `${actor} removed ${target} as admin`
    );
    await broadcastConversation(conv._id);
    res.json({ ok: true });
  })
);

router.delete(
  '/:id/members/:userId',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    const targetId = req.params.userId;
    const leaving = targetId === req.userId;
    if (conv.type !== 'group') throw new HttpError(400, 'Only groups support this');
    if (!leaving) requireGroupAdmin(conv, req.userId);
    const target = conv.member(targetId);
    if (!target) throw new HttpError(404, 'Not a member');

    conv.participants = conv.participants.filter((p) => !sameId(p.user, targetId));
    // Never leave a group without an admin: promote the longest-standing member.
    if (conv.participants.length && !conv.participants.some((p) => p.role === 'admin')) {
      const next = [...conv.participants].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      next.role = 'admin';
    }
    await conv.save();

    removeUserFromConversation(conv._id, targetId);
    const [actor, removed] = await names([req.userId, targetId]);
    if (conv.participants.length) {
      await postSystem(conv, leaving ? `${actor} left` : `${actor} removed ${removed}`);
      await broadcastConversation(conv._id);
    }
    res.json({ ok: true });
  })
);

router.get(
  '/:id/messages',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    const me = conv.member(req.userId);
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    // Direct chats show full history; groups only from when you joined.
    const from =
      conv.type === 'direct'
        ? me.clearedAt || new Date(0)
        : new Date(Math.max(+me.joinedAt || 0, +me.clearedAt || 0));

    const createdAt = { $gte: from };
    if (req.query.before) createdAt.$lt = new Date(String(req.query.before));

    const docs = await Message.find({
      conversation: conv._id,
      createdAt,
      deletedFor: { $ne: req.userId },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .populate(REPLY_POPULATE);

    const hasMore = docs.length > limit;
    const page = docs.slice(0, limit).reverse();
    res.json({ messages: page.map((m) => serializeMessage(m, req.userId)), hasMore });
  })
);

const sendSchema = z
  .object({
    clientId: z.string().min(8).max(64),
    type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'file']).default('text'),
    text: z.string().max(10000).default(''),
    media: z
      .object({
        url: uploadUrl,
        name: z.string().max(200).optional(),
        size: z.number().nonnegative().optional(),
        mime: z.string().max(100).optional(),
        duration: z.number().nonnegative().max(24 * 3600).optional(),
      })
      .optional(),
    replyTo: objectId.nullish(),
    forwarded: z.boolean().optional(),
  })
  .refine((d) => (d.type === 'text' ? d.text.trim().length > 0 : !!d.media), 'Message is empty');

/**
 * Send over plain HTTP. The app normally sends through the realtime socket; this is used
 * by the Android background worker to deliver queued messages while the app is closed.
 * Same clientId = same message, so a message sent both ways is only stored once.
 */
router.post(
  '/:id/messages',
  handle(async (req, res) => {
    const data = sendSchema.parse(req.body);
    const conv = await loadForUser(req);
    if (!canSend(conv, req.userId)) throw new HttpError(403, 'Only admins can send messages to this group');

    const replyTo =
      data.replyTo && (await Message.exists({ _id: data.replyTo, conversation: conv._id })) ? data.replyTo : null;
    const { message, duplicate } = await createMessage({
      conversation: conv,
      senderId: req.userId,
      type: data.type,
      text: data.text,
      media: data.media,
      replyTo,
      forwarded: data.forwarded,
      clientId: data.clientId,
    });
    if (!duplicate) {
      broadcastMessage(message, conv);
      pushNewMessage(message, conv);
    }
    res.status(duplicate ? 200 : 201).json({ message: serializeMessage(message, req.userId), duplicate });
  })
);

router.get(
  '/:id/search',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ messages: [] });
    const me = conv.member(req.userId);
    const docs = await Message.find({
      conversation: conv._id,
      type: { $ne: 'system' },
      deletedForEveryone: false,
      deletedFor: { $ne: req.userId },
      createdAt: { $gte: me.clearedAt || new Date(0) },
      text: new RegExp(escapeRegex(q), 'i'),
    })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ messages: docs.map((m) => serializeMessage(m, req.userId)) });
  })
);

router.get(
  '/:id/media',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    const docs = await Message.find({
      conversation: conv._id,
      type: { $in: ['image', 'video', 'file', 'audio'] },
      deletedForEveryone: false,
      deletedFor: { $ne: req.userId },
    })
      .sort({ createdAt: -1 })
      .limit(90);
    res.json({ messages: docs.map((m) => serializeMessage(m, req.userId)) });
  })
);

export default router;
