import crypto from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  Conversation,
  EVENTS,
  MAX_TEXT_LENGTH,
  Message,
  REPLY_POPULATE,
  User,
  blockStatus,
  canSend,
  createMessage,
  createSystemMessage,
  pushNewMessage,
  pushRead,
  escapeRegex,
  findChatForUser,
  groupPermissions,
  publicUser,
  sameId,
  serializeConversation,
  serializeMessage,
  USER_FIELDS,
  userLabel,
  withConversationRefs,
} from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { uploadUrl } from './users.js';
import {
  broadcastConversation,
  broadcastMessage,
  emitToConversations,
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
  editInfo: z.enum(['all', 'admins']).optional(),
  addMembers: z.enum(['all', 'admins']).optional(),
  approveJoins: z.boolean().optional(),
  disappearingSeconds: z
    .number()
    .int()
    .refine((v) => v in DISAPPEARING_OPTIONS, 'Unsupported disappearing timer')
    .optional(),
});

const prefsSchema = z.object({
  markedUnread: z.boolean().optional(), // "Mark as unread" / "Mark as read"
  pinned: z.boolean().optional(),
  muted: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const router = Router();

async function loadForUser(req) {
  const conv = await findChatForUser(req.params.id, req.userId);
  // (The hidden own-devices channel isn't a chat: none of the chat routes apply to it.)
  if (!conv) throw new HttpError(404, 'Conversation not found');
  return conv;
}

function requireGroupAdmin(conv, userId) {
  if (conv.type !== 'group') throw new HttpError(400, 'Only groups support this');
  if (conv.member(userId)?.role !== 'admin') throw new HttpError(403, 'Only group admins can do that');
}

/** How people appear in group notices, which every member sees: @username, else the number. */
async function names(ids) {
  const users = await User.find({ _id: { $in: ids } }, 'username phone').lean();
  const byId = new Map(users.map((u) => [String(u._id), userLabel(u)]));
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
      Conversation.find({ 'participants.user': req.userId, type: { $in: ['direct', 'group'] } }).sort({ lastMessageAt: -1 })
    );
    res.json({ conversations: convs.map((c) => serializeConversation(c, req.userId, { historyFrom: req.historyFrom })) });
  })
);

// ---- Shared media, docs, links and apps (contact/group info "View all", and the Media hub)

const SHARED_KINDS = ['all', 'media', 'docs', 'links', 'apps', 'starred'];
const APK = { $or: [{ 'media.mime': 'application/vnd.android.package-archive' }, { 'media.name': /\.apk$/i }] };
const NOT_APK = { 'media.mime': { $ne: 'application/vnd.android.package-archive' }, 'media.name': { $not: /\.apk$/i } };
const LINK = /(https?:\/\/|www\.)\S+/i;

/** What each tab shows. */
function kindFilter(kind, userId) {
  const media = { type: { $in: ['image', 'video'] }, viewOnce: { $ne: true } };
  const docs = { type: 'file', ...NOT_APK };
  const apps = { type: 'file', ...APK };
  const links = { text: LINK };
  if (kind === 'media') return media;
  if (kind === 'docs') return docs;
  if (kind === 'apps') return apps;
  if (kind === 'links') return links;
  if (kind === 'starred') return { starredBy: userId };
  return { $or: [media, { type: 'file' }, links] };
}

/** The messages I may see in each chat: since I joined (groups) / since I cleared it. */
function visibleIn(conversations, userId, historyFrom = null) {
  return conversations.map((c) => {
    const me = c.participants.find((p) => sameId(p.user, userId));
    const from =
      c.type === 'direct' ? me?.clearedAt || new Date(0) : new Date(Math.max(+me?.joinedAt || 0, +me?.clearedAt || 0));
    return { conversation: c._id, createdAt: { $gte: new Date(Math.max(+from, +historyFrom || 0)) } };
  });
}

/**
 * GET /api/conversations/shared?kind=all|media|docs|links|apps|starred&q=&before=&conversationId=
 * Newest first, 60 at a time. Without conversationId it covers all my chats (the Media hub).
 * `counts=1` adds how many there are of each kind (first page only).
 */
router.get(
  '/shared',
  handle(async (req, res) => {
    const kind = SHARED_KINDS.includes(req.query.kind) ? req.query.kind : 'all';
    const limit = Math.min(Number(req.query.limit) || 60, 100);
    const conversations = req.query.conversationId
      ? [await findChatForUser(String(req.query.conversationId), req.userId)].filter(Boolean)
      : await Conversation.find({ 'participants.user': req.userId }, 'type participants');
    if (!conversations.length) return res.json({ items: [], hasMore: false });

    const base = {
      $and: [{ $or: visibleIn(conversations, req.userId, req.historyFrom) }],
      deletedForEveryone: false,
      deletedFor: { $ne: req.userId },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    };
    const q = String(req.query.q || '').trim();
    const search = q ? { $or: [{ text: new RegExp(escapeRegex(q), 'i') }, { 'media.name': new RegExp(escapeRegex(q), 'i') }] } : null;
    const filter = { ...base, $and: [...base.$and, kindFilter(kind, req.userId), ...(search ? [search] : [])] };
    if (req.query.before) filter.createdAt = { $lt: new Date(String(req.query.before)) };

    const docs = await Message.find(filter).sort({ createdAt: -1 }).limit(limit + 1);
    const out = { items: docs.slice(0, limit).map((m) => serializeMessage(m, req.userId)), hasMore: docs.length > limit };
    if (req.query.counts && !req.query.before) {
      const counts = {};
      for (const k of SHARED_KINDS) {
        counts[k] = await Message.countDocuments({ ...base, $and: [...base.$and, kindFilter(k, req.userId)] });
      }
      out.counts = counts;
    }
    res.json(out);
  })
);

/** Call history (the Calls tab): the latest calls across all of my chats. */
router.get(
  '/calls',
  handle(async (req, res) => {
    const mine = await Conversation.find({ 'participants.user': req.userId }, '_id').lean();
    const docs = await Message.find({
      conversation: { $in: mine.map((c) => c._id) },
      ...(req.historyFrom && { createdAt: { $gte: req.historyFrom } }),
      type: 'call',
      deletedFor: { $ne: req.userId },
    })
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 100, 200));
    res.json({ calls: docs.map((m) => serializeMessage(m, req.userId)) });
  })
);

router.get(
  '/:id',
  handle(async (req, res) => {
    const conv = await withConversationRefs(
      Conversation.findOne({ _id: req.params.id, 'participants.user': req.userId })
    );
    if (!conv) throw new HttpError(404, 'Conversation not found');
    res.json({ conversation: serializeConversation(conv, req.userId, { historyFrom: req.historyFrom }) });
  })
);

router.post(
  '/direct',
  handle(async (req, res) => {
    const { userId } = z.object({ userId: objectId }).parse(req.body);
    // Messaging yourself (notes, links, files to keep) is a one-member direct chat.
    const self = userId === req.userId;
    if (!self && !(await User.exists({ _id: userId }))) throw new HttpError(404, 'User not found');

    const directKey = [req.userId, userId].sort().join(':');
    let conv = await Conversation.findOne({ directKey });
    if (!conv) {
      try {
        conv = await Conversation.create({
          type: 'direct',
          directKey,
          createdBy: req.userId,
          participants: self ? [{ user: req.userId }] : [{ user: req.userId }, { user: userId }],
        });
        await broadcastConversation(conv._id, { join: self ? [req.userId] : [req.userId, userId] });
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

    // Name, photo, description and timer: admins, or everyone when the group allows it.
    // The group's settings themselves: admins only.
    const infoFields = ['name', 'description', 'avatarUrl'].filter((k) => data[k] !== undefined);
    const settingFields = ['onlyAdminsCanSend', 'editInfo', 'addMembers', 'approveJoins'].filter((k) => data[k] !== undefined);
    const everyoneEdits = conv.type === 'group' && groupPermissions(conv).editInfo === 'all';
    if (infoFields.length && !everyoneEdits) requireGroupAdmin(conv, req.userId);
    if (data.disappearingSeconds !== undefined && conv.type === 'group' && !everyoneEdits) requireGroupAdmin(conv, req.userId);
    if (settingFields.length) requireGroupAdmin(conv, req.userId);

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
    const perms = groupPermissions(conv);
    if (data.editInfo !== undefined && data.editInfo !== perms.editInfo) {
      conv.permissions = { ...perms, editInfo: data.editInfo };
      notes.push(
        data.editInfo === 'all'
          ? `${actor} changed this group's settings to allow all members to edit this group's info`
          : `${actor} changed this group's settings to allow only admins to edit this group's info`
      );
    }
    if (data.addMembers !== undefined && data.addMembers !== perms.addMembers) {
      conv.permissions = { ...groupPermissions(conv), addMembers: data.addMembers };
      notes.push(
        data.addMembers === 'all'
          ? `${actor} changed this group's settings to allow all members to add others`
          : `${actor} changed this group's settings to allow only admins to add others`
      );
    }
    if (data.approveJoins !== undefined && data.approveJoins !== !!conv.approveJoins) {
      conv.approveJoins = data.approveJoins;
      notes.push(
        data.approveJoins
          ? `${actor} turned on admin approval to join this group`
          : `${actor} turned off admin approval to join this group`
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
      { $set: { 'participants.$.clearedAt': new Date(), 'participants.$.unreadCount': 0, 'participants.$.unreadMentions': 0 } }
    );
    res.json({ conversation: await sendOwnView(req.params.id, req.userId) });
  })
);

/**
 * "This phone received the messages up to `upTo`": sent by the Android app as soon as a
 * message notification arrives, even with ChatApp closed, so the sender sees two ticks.
 */
router.post(
  '/:id/delivered',
  handle(async (req, res) => {
    const { upTo } = z.object({ upTo: z.string().datetime().optional() }).parse(req.body || {});
    const conv = await loadForUser(req);
    const at = new Date(Math.min(upTo ? Date.parse(upTo) : Date.now(), Date.now()));
    const result = await Conversation.updateOne(
      { _id: conv._id, participants: { $elemMatch: { user: req.userId, lastDeliveredAt: { $lt: at } } } },
      { $set: { 'participants.$.lastDeliveredAt': at } }
    );
    if (result.modifiedCount) {
      emitToConversations([String(conv._id)], EVENTS.RECEIPT, {
        conversationId: String(conv._id),
        userId: req.userId,
        kind: 'delivered',
        at,
      });
    }
    res.json({ ok: true });
  })
);

/**
 * Mark read over plain HTTP: the "Mark as read" button on a notification, which works
 * without opening the app. Same rules as the realtime service's conversation:read.
 */
router.post(
  '/:id/read',
  handle(async (req, res) => {
    const { upTo } = z.object({ upTo: z.string().datetime().optional() }).parse(req.body || {});
    const conv = await loadForUser(req);
    const at = new Date(Math.min(upTo ? Date.parse(upTo) : Date.now(), Date.now()));
    for (const field of ['lastDeliveredAt', 'lastReadAt']) {
      await Conversation.updateOne(
        { _id: conv._id, participants: { $elemMatch: { user: req.userId, [field]: { $lt: at } } } },
        { $set: { [`participants.$.${field}`]: at } }
      );
    }
    const unreadCount = await Message.countDocuments({
      conversation: conv._id,
      sender: { $ne: req.userId },
      createdAt: { $gt: at },
      $nor: [{ type: 'call', 'call.status': { $ne: 'missed' } }],
    });
    const unreadMentions = await Message.countDocuments({ conversation: conv._id, mentions: req.userId, createdAt: { $gt: at } });
    await Conversation.updateOne(
      { _id: conv._id, 'participants.user': req.userId },
      { $set: { 'participants.$.unreadCount': unreadCount, 'participants.$.unreadMentions': unreadMentions, 'participants.$.markedUnread': false } }
    );
    emitToConversations([String(conv._id)], EVENTS.RECEIPT, {
      conversationId: String(conv._id),
      userId: req.userId,
      kind: 'read',
      at,
      unreadCount,
    });
    if (unreadCount === 0) pushRead(req.userId, String(conv._id));
    res.json({ unreadCount });
  })
);

/** The group's invite link code (admins only); made on first use. */
router.get(
  '/:id/invite',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);
    if (!conv.inviteCode) {
      conv.inviteCode = crypto.randomBytes(16).toString('base64url');
      await conv.save();
    }
    res.json({ code: conv.inviteCode });
  })
);

/** A new code: the old link stops working at once. */
router.post(
  '/:id/invite/reset',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);
    conv.inviteCode = crypto.randomBytes(16).toString('base64url');
    await conv.save();
    res.json({ code: conv.inviteCode });
  })
);

router.post(
  '/:id/members',
  handle(async (req, res) => {
    const { userIds } = z.object({ userIds: z.array(objectId).min(1).max(100) }).parse(req.body);
    const conv = await loadForUser(req);
    if (conv.type !== 'group' || groupPermissions(conv).addMembers !== 'all') requireGroupAdmin(conv, req.userId);

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
    // Added directly: no longer waiting to join.
    if (conv.joinRequests?.length) conv.joinRequests = conv.joinRequests.filter((r) => !newIds.includes(String(r.user)));
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

// ---- Joining with admin approval

/** How a person appears to this admin: only what they allow (phone, email, last seen). */
async function viewerHidesLastSeen(userId) {
  return (await User.findById(userId, 'settings').lean())?.settings?.showLastSeen === false;
}

/** People asking to join by invite link (admins). */
router.get(
  '/:id/join-requests',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);
    const list = conv.joinRequests || [];
    const users = await User.find({ _id: { $in: list.map((r) => r.user) } }, USER_FIELDS).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const hideLastSeen = await viewerHidesLastSeen(req.userId);
    res.json({
      requests: list
        .filter((r) => byId.has(String(r.user)))
        .map((r) => ({ ...publicUser(byId.get(String(r.user)), { hideLastSeen }), requestedAt: r.at })),
    });
  })
);

/** Let someone in, or not. */
router.post(
  '/:id/join-requests/:userId',
  handle(async (req, res) => {
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);
    const targetId = req.params.userId;
    if (!mongoose.isValidObjectId(targetId)) throw new HttpError(404, 'Request not found');
    // Atomic: two admins answering at once can't both act on it.
    const taken = await Conversation.updateOne({ _id: conv._id, 'joinRequests.user': targetId }, { $pull: { joinRequests: { user: targetId } } });
    if (!taken.modifiedCount) throw new HttpError(410, 'This request was already answered');
    if (approve) {
      const fresh = await Conversation.findById(conv._id);
      if (fresh.participants.length >= MAX_GROUP_SIZE) throw new HttpError(400, 'Group is full');
      const now = new Date();
      const added = await Conversation.updateOne(
        { _id: conv._id, 'participants.user': { $ne: targetId } },
        { $push: { participants: { user: targetId, joinedAt: now, lastReadAt: now, lastDeliveredAt: now } } }
      );
      if (added.modifiedCount) {
        const [actor, joined] = await names([req.userId, targetId]);
        await postSystem(await Conversation.findById(conv._id), `${actor} approved ${joined} to join`);
        await broadcastConversation(conv._id, { join: [targetId] });
        return res.json({ ok: true });
      }
    }
    await broadcastConversation(conv._id); // admins' pending count
    res.json({ ok: true });
  })
);

// ---- Group dashboard (admins): activity from message metadata only

const insightsQuery = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), 'Pick 7, 30 or 90 days').default(30),
  // The viewer's Date#getTimezoneOffset(), so days and hours are theirs.
  tz: z.coerce.number().int().min(-840).max(840).default(0),
});

/**
 * Counts per day, per hour of the day and per member. Encrypted messages count like any other:
 * the server knows who sent a message and when, never what it says. Members appear as they
 * allow (phone, email, last seen), and someone who turned off "Share my activity in group
 * insights" shows no per-person numbers (they still count in the group's totals).
 */
router.get(
  '/:id/insights',
  handle(async (req, res) => {
    const { days, tz } = insightsQuery.parse(req.query);
    const conv = await loadForUser(req);
    requireGroupAdmin(conv, req.userId);

    const offset = -tz; // minutes ahead of UTC
    const timezone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    const local = new Date(Date.now() + offset * 60000);
    const todayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    const since = new Date(todayStart - (days - 1) * 86400000 - offset * 60000);

    const inRange = { createdAt: { $gte: since } };
    const [agg] = await Message.aggregate([
      { $match: { conversation: conv._id, type: { $nin: ['system', 'call'] }, sender: { $ne: null } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          perSender: [
            {
              $group: {
                _id: '$sender',
                total: { $sum: 1 },
                inRange: { $sum: { $cond: [{ $gte: ['$createdAt', since] }, 1, 0] } },
                last: { $max: '$createdAt' },
              },
            },
          ],
          daily: [{ $match: inRange }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } }, n: { $sum: 1 } } }],
          hours: [{ $match: inRange }, { $group: { _id: { $hour: { date: '$createdAt', timezone } }, n: { $sum: 1 } } }],
        },
      },
    ]);

    const dayCounts = new Map(agg.daily.map((d) => [d._id, d.n]));
    const daily = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(todayStart - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
      daily.push({ date, count: dayCounts.get(date) || 0 });
    }
    const hours = Array.from({ length: 24 }, (_, h) => agg.hours.find((x) => x._id === h)?.n || 0);

    const stats = new Map(agg.perSender.map((s) => [String(s._id), s]));
    const users = await User.find({ _id: { $in: conv.participants.map((p) => p.user) } }, USER_FIELDS).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const hideLastSeen = await viewerHidesLastSeen(req.userId);
    const members = conv.participants.map((p) => {
      const id = String(p.user);
      const u = byId.get(id);
      const isMe = id === req.userId;
      const blockedMe = (u?.blocked || []).some((b) => sameId(b, req.userId));
      const shares = isMe || u?.settings?.shareGroupActivity !== false;
      const s = stats.get(id);
      const pub = publicUser(u, { hideLastSeen: hideLastSeen && !isMe }) || { id };
      return {
        id,
        username: pub.username ?? null,
        avatarUrl: blockedMe ? null : pub.avatarUrl ?? null,
        lastSeen: blockedMe ? null : pub.lastSeen ?? null,
        ...(pub.phone && { phone: pub.phone }),
        ...((pub.email || (isMe && u?.email)) && { email: pub.email || u.email }),
        role: p.role,
        joinedAt: p.joinedAt,
        activityHidden: !shares,
        messages: shares ? s?.inRange || 0 : null,
        total: shares ? s?.total || 0 : null,
        lastMessageAt: shares ? s?.last || null : null,
      };
    });

    res.json({
      days,
      since,
      totals: {
        members: conv.participants.length,
        admins: conv.participants.filter((p) => p.role === 'admin').length,
        messages: agg.total[0]?.n || 0,
        messagesInRange: daily.reduce((n, d) => n + d.count, 0),
        activeMembers: conv.participants.filter((p) => (stats.get(String(p.user))?.inRange || 0) > 0).length,
        newMembers: conv.participants.filter((p) => p.joinedAt >= since).length,
        pendingJoins: (conv.joinRequests || []).length,
      },
      daily,
      hours,
      members,
    });
  })
);

router.get(
  '/:id/messages',
  handle(async (req, res) => {
    const conv = await loadForUser(req);
    const me = conv.member(req.userId);
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    // Direct chats show full history; groups only from when you joined.
    const chatFrom =
      conv.type === 'direct'
        ? me.clearedAt || new Date(0)
        : new Date(Math.max(+me.joinedAt || 0, +me.clearedAt || 0));
    // A device that chose not to sync starts from when it signed in.
    const from = new Date(Math.max(+chatFrom, +req.historyFrom || 0));

    const createdAt = { $gte: from };
    if (req.query.before) createdAt.$lt = new Date(String(req.query.before));
    // `after`: the messages that came after this time, oldest first (a device catching up).
    const after = req.query.after && !req.query.before ? new Date(String(req.query.after)) : null;
    if (after && !Number.isNaN(+after)) {
      createdAt.$gt = after;
      const docs = await Message.find({
        conversation: conv._id,
        createdAt,
        deletedFor: { $ne: req.userId },
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      })
        .sort({ createdAt: 1 })
        .limit(limit + 1)
        .populate(REPLY_POPULATE);
      return res.json({ messages: docs.slice(0, limit).map((m) => serializeMessage(m, req.userId)), hasMore: docs.length > limit });
    }

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
    type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'file', 'poll']).default('text'),
    text: z.string().max(MAX_TEXT_LENGTH).default(''),
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
    viewOnce: z.boolean().optional(),
    e2ee: z
      .object({ ciphertext: z.string().min(16).max(400_000).regex(/^[A-Za-z0-9+/=]+$/), epoch: z.number().int().min(0) })
      .optional(),
    mentions: z.array(objectId).max(512).optional(), // encrypted messages say whom they mention
    pollMeta: z.object({ count: z.number().int().min(2).max(12), multiple: z.boolean().optional() }).optional(),
    poll: z
      .object({
        question: z.string().trim().min(1, 'Ask a question').max(300),
        options: z.array(z.string().trim().min(1).max(100)).min(2, 'Add at least 2 options').max(12),
        multiple: z.boolean().optional(),
      })
      .refine((p) => new Set(p.options.map((o) => o.toLowerCase())).size === p.options.length, 'Options must be different')
      .optional(),
  })
  .refine((d) => (d.type === 'text' ? d.text.trim().length > 0 || !!d.e2ee : d.type === 'poll' ? !!d.poll : !!d.media), 'Message is empty')
  // Encrypted messages go as "text" whatever they contain (the content and its kind are in the
  // ciphertext). View-once keeps its file address here: the server hands it out once.
  .refine((d) => !d.e2ee || (d.type === 'text' && !d.text && (!d.media || d.viewOnce)), 'Invalid encrypted message')
  .refine((d) => !d.pollMeta || !!d.e2ee, 'Invalid poll')
  .refine((d) => !d.viewOnce || d.type === 'image' || d.type === 'video' || (d.e2ee && d.media), 'Only photos and videos can be view once');

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
    const block = await blockStatus(conv, req.userId);
    if (block.iBlocked) throw new HttpError(403, 'You blocked this contact. Unblock them to send a message.');
    // Every message is end-to-end encrypted: plaintext is refused (an old or tampered app).
    if (!data.e2ee) throw new HttpError(409, 'Messages must be end-to-end encrypted. Update ChatApp to send messages.');
    if (data.e2ee && !req.deviceId) throw new HttpError(400, 'Update ChatApp to send encrypted messages.');
    const { message, duplicate } = await createMessage({
      conversation: conv,
      senderId: req.userId,
      type: data.type,
      text: data.text,
      media: data.media,
      replyTo,
      forwarded: data.forwarded,
      viewOnce: data.viewOnce,
      poll: data.poll,
      pollMeta: data.pollMeta,
      ...(data.e2ee && { e2ee: { ...data.e2ee, device: req.deviceId }, mentionIds: data.mentions || [] }),
      clientId: data.clientId,
      hiddenFrom: block.blockedMe ? [block.peerId] : [], // they blocked me: never reaches them
    });
    if (!duplicate && block.blockedMe) {
      emitToUser(req.userId, EVENTS.MESSAGE_NEW, serializeMessage(message));
    } else if (!duplicate) {
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
      createdAt: { $gte: new Date(Math.max(+me.clearedAt || 0, +req.historyFrom || 0)) },
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
      viewOnce: { $ne: true },
      deletedForEveryone: false,
      deletedFor: { $ne: req.userId },
    })
      .sort({ createdAt: -1 })
      .limit(90);
    res.json({ messages: docs.map((m) => serializeMessage(m, req.userId)) });
  })
);

export default router;
