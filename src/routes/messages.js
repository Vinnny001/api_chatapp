import { Router } from 'express';
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
