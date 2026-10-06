import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  EVENTS,
  Message,
  REPLY_POPULATE,
  User,
  canSend,
  createSystemMessage,
  findConversationForUser,
  userLabel,
  pushReaction,
  pushReactionRemoved,
  reactToMessage,
  sameId,
  serializeMessage,
  serializePoll,
} from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { broadcastConversation, broadcastMessage, emitToConversations, emitToUser } from '../realtime.js';

const router = Router();

router.get(
  '/starred',
  handle(async (req, res) => {
    const docs = await Message.find({ starredBy: req.userId, deletedForEveryone: false })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate(REPLY_POPULATE);
    res.json({ messages: docs.map((m) => serializeMessage(m, req.userId)) });
  })
);

router.post(
  '/:id/star',
  handle(async (req, res) => {
    const message = await Message.findById(req.params.id);
    if (!message || !(await findConversationForUser(message.conversation, req.userId))) {
      throw new HttpError(404, 'Message not found');
    }
    const starred = message.starredBy.some((u) => sameId(u, req.userId));
    await Message.updateOne(
      { _id: message._id },
      starred ? { $pull: { starredBy: req.userId } } : { $addToSet: { starredBy: req.userId } }
    );
    const payload = { id: String(message._id), conversationId: String(message.conversation), starred: !starred };
    emitToUser(req.userId, EVENTS.MESSAGE_UPDATED, payload); // keep the user's other devices in sync
    res.json(payload);
  })
);

/**
 * View once: hands the media url to a recipient the first time they open it, never again.
 * Once every recipient has opened it the url is forgotten.
 */
router.post(
  '/:id/open',
  handle(async (req, res) => {
    const message = await Message.findById(req.params.id);
    const conv = message && (await findConversationForUser(message.conversation, req.userId));
    if (!conv || !message.viewOnce) throw new HttpError(404, 'Message not found');
    if (sameId(message.sender, req.userId)) throw new HttpError(403, 'You can’t open a view once message you sent');
    const url = message.media?.url;
    // Atomic: two taps (or two phones) can't both get it.
    const opened = await Message.updateOne(
      { _id: message._id, openedBy: { $ne: req.userId }, 'media.url': { $exists: true } },
      { $addToSet: { openedBy: req.userId } }
    );
    if (!url || !opened.modifiedCount) throw new HttpError(410, 'You already opened this');
    const fresh = await Message.findById(message._id, 'openedBy sender');
    const openedBy = fresh.openedBy.map(String);
    const everyone = conv.participants.filter((p) => !sameId(p.user, message.sender)).every((p) => openedBy.includes(String(p.user)));
    if (everyone) await Message.updateOne({ _id: message._id }, { $unset: { 'media.url': 1 } });
    emitToConversations([conv._id], EVENTS.MESSAGE_UPDATED, { id: String(message._id), conversationId: String(conv._id), openedBy });
    res.json({ url, type: message.type, mime: message.media.mime });
  })
);

/** Vote in a poll: options replaces my vote ([] takes it back). */
router.post(
  '/:id/vote',
  handle(async (req, res) => {
    const { options } = z.object({ options: z.array(z.string().max(4)).max(12) }).parse(req.body);
    const message = await Message.findById(req.params.id);
    const conv = message && (await findConversationForUser(message.conversation, req.userId));
    if (!conv || message.type !== 'poll' || message.deletedForEveryone) throw new HttpError(404, 'Poll not found');
    const valid = new Set(message.poll.options.map((o) => o.id));
    const picked = [...new Set(options)].filter((o) => valid.has(o));
    if (!message.poll.multiple && picked.length > 1) throw new HttpError(400, 'Pick one option');
    // One atomic update (my old votes out, new ones in), so quick taps can't interleave.
    const me = new mongoose.Types.ObjectId(req.userId);
    await Message.updateOne({ _id: message._id }, [
      {
        $set: {
          'poll.votes': {
            $concatArrays: [
              { $filter: { input: '$poll.votes', cond: { $ne: ['$$this.user', me] } } },
              picked.map((option) => ({ user: me, option })),
            ],
          },
        },
      },
    ]);
    const fresh = await Message.findById(message._id, 'poll');
    const poll = serializePoll(fresh.poll);
    emitToConversations([conv._id], EVENTS.MESSAGE_UPDATED, { id: String(message._id), conversationId: String(conv._id), poll });
    res.json({ poll });
  })
);

const MAX_PINS = 3;

/** Pin a message in its chat (up to 3; pinning a 4th unpins the oldest). */
router.post(
  '/:id/pin',
  handle(async (req, res) => {
    const message = await Message.findById(req.params.id);
    const conv = message && (await findConversationForUser(message.conversation, req.userId));
    if (!conv) throw new HttpError(404, 'Message not found');
    if (message.deletedForEveryone || message.type === 'system') throw new HttpError(400, 'This message can not be pinned');
    if (!canSend(conv, req.userId)) throw new HttpError(403, 'Only admins can pin messages in this group');
    const pins = (conv.pinned || []).filter((p) => String(p.message) !== String(message._id));
    pins.push({ message: message._id, by: req.userId, at: new Date() });
    conv.pinned = pins.slice(-MAX_PINS);
    await conv.save();
    const me = await User.findById(req.userId, 'username phone').lean();
    const { message: note } = await createSystemMessage(conv, `${userLabel(me)} pinned a message`);
    broadcastMessage(note, conv);
    await broadcastConversation(conv._id);
    res.json({ ok: true });
  })
);

router.delete(
  '/:id/pin',
  handle(async (req, res) => {
    const message = await Message.findById(req.params.id, 'conversation');
    const conv = message && (await findConversationForUser(message.conversation, req.userId));
    if (!conv) throw new HttpError(404, 'Message not found');
    if (!canSend(conv, req.userId)) throw new HttpError(403, 'Only admins can unpin messages in this group');
    conv.pinned = (conv.pinned || []).filter((p) => String(p.message) !== String(message._id));
    await conv.save();
    await broadcastConversation(conv._id);
    res.json({ ok: true });
  })
);

/** React over plain HTTP (the app uses this when its live connection is down). */
router.post(
  '/:id/react',
  handle(async (req, res) => {
    const { emoji } = z.object({ emoji: z.string().min(1).max(16).nullable() }).parse(req.body);
    let result;
    try {
      result = await reactToMessage({ messageId: req.params.id, userId: req.userId, emoji });
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
    const { message, conversation, patch, added, removed, preview } = result;
    emitToConversations([patch.conversationId], EVENTS.MESSAGE_UPDATED, patch);
    if (added) pushReaction({ message, conversation, reactorId: req.userId, emoji: added, preview });
    if (removed) pushReactionRemoved({ message, conversation, reactorId: req.userId });
    res.json({ reactions: patch.reactions });
  })
);

export default router;
