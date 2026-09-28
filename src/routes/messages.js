import { Router } from 'express';
import { EVENTS, Message, REPLY_POPULATE, findConversationForUser, sameId, serializeMessage } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToUser } from '../realtime.js';

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

export default router;
