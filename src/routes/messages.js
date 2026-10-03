import { Router } from 'express';
import { z } from 'zod';
import {
  EVENTS,
  Message,
  REPLY_POPULATE,
  findConversationForUser,
  pushReaction,
  pushReactionRemoved,
  reactToMessage,
  sameId,
  serializeMessage,
} from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToConversations, emitToUser } from '../realtime.js';

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
