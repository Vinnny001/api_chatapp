import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  Conversation,
  EVENTS,
  User,
  config,
  createMessage,
  findConversationForUser,
  idOf,
  pushCallEnded,
  pushGroupCall,
  serializeGroupCall,
  userLabel,
} from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { broadcastMessage, emitToConversations } from '../realtime.js';

// Group voice/video calls run on LiveKit (the media goes through LiveKit's servers). This API
// decides who may join (a short-lived token per person), rings the group, and logs the call
// in the chat when the last person leaves. One-to-one calls stay peer-to-peer (realtime).

const lk = config.livekit;
const enabled = () => Boolean(lk.url && lk.apiKey && lk.apiSecret);
let roomService = null;
const rooms = () => (roomService ??= new RoomServiceClient(lk.url.replace(/^ws/, 'http'), lk.apiKey, lk.apiSecret));

/** Who is in the LiveKit room right now ([] when it doesn't exist or can't be reached). */
async function inRoom(room) {
  try {
    return await rooms().listParticipants(room);
  } catch {
    return [];
  }
}

function announce(conv) {
  emitToConversations([idOf(conv)], EVENTS.GROUP_CALL, {
    conversationId: idOf(conv),
    groupCall: serializeGroupCall(conv.groupCall),
  });
}

/** Ends a group call once: logs it in the chat, stops the ringing, tells the group. */
export async function endGroupCall(conversationId) {
  // Cleared atomically, so two people leaving at once log it only once.
  const conv = await Conversation.findOneAndUpdate(
    { _id: conversationId, 'groupCall.id': { $type: 'string' } },
    { $set: { groupCall: null } }
  );
  const call = conv?.groupCall;
  if (!call?.id) return;
  const joined = (call.joined || []).map(String);
  const answered = joined.length > 1; // someone besides the caller joined
  const { message } = await createMessage({
    conversation: conv,
    senderId: call.startedBy,
    type: 'call',
    call: {
      kind: call.kind,
      status: answered ? 'answered' : 'missed',
      duration: answered ? Math.round((Date.now() - call.startedAt) / 1000) : 0,
      group: true,
      participants: call.joined,
    },
    clientId: `gcall-${call.id}`,
    countsAsUnread: false,
  });
  broadcastMessage(message, conv);
  conv.groupCall = null;
  announce(conv);
  // Members who never joined: stop the ringing and show "Missed group call".
  const group = { id: idOf(conv), name: conv.name || 'Group', avatarUrl: conv.avatarUrl, group: true };
  for (const p of conv.participants) {
    const id = idOf(p.user);
    if (!joined.includes(id)) {
      pushCallEnded(id, { callId: call.id, conversationId: idOf(conv), kind: call.kind, status: 'missed', caller: group });
    }
  }
  rooms().deleteRoom(call.room).catch(() => {});
}

const router = Router();

/**
 * Start the group's call, or join the one in progress. Returns what the app needs to
 * connect: { url, token, groupCall, started }.
 */
router.post(
  '/:id/group-call',
  handle(async (req, res) => {
    if (!enabled()) throw new HttpError(503, 'Group calls aren’t set up on the server yet');
    const { kind } = z.object({ kind: z.enum(['audio', 'video']).default('audio') }).parse(req.body || {});
    let conv = await findConversationForUser(req.params.id, req.userId);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    if (conv.type !== 'group') throw new HttpError(400, 'Group calls are for groups');

    // A call everyone left without saying so (app closed, phone off) is ended first.
    const stale = conv.groupCall?.id && Date.now() - conv.groupCall.startedAt > 60_000;
    if (stale && !(await inRoom(conv.groupCall.room)).length) {
      await endGroupCall(conv._id);
      conv = await Conversation.findById(conv._id);
    }

    let started = false;
    if (!conv.groupCall?.id) {
      const call = {
        id: crypto.randomUUID(),
        room: `group-${conv._id}-${Date.now().toString(36)}`,
        kind,
        startedBy: req.userId,
        startedAt: new Date(),
        joined: [req.userId],
      };
      const result = await Conversation.updateOne({ _id: conv._id, groupCall: null }, { $set: { groupCall: call } });
      started = result.modifiedCount === 1; // someone else may have started one a moment ago
    }
    if (!started) await Conversation.updateOne({ _id: conv._id }, { $addToSet: { 'groupCall.joined': req.userId } });
    conv = await Conversation.findById(conv._id);
    const call = conv.groupCall;
    announce(conv);

    if (started) {
      const starter = await User.findById(req.userId, 'username phone').lean();
      const others = conv.participants.map((p) => idOf(p.user)).filter((id) => id !== req.userId);
      pushGroupCall(others, { callId: call.id, conversation: conv, kind: call.kind, starter });
    }

    const me = await User.findById(req.userId, 'username phone avatarUrl').lean();
    const token = new AccessToken(lk.apiKey, lk.apiSecret, {
      identity: req.userId,
      name: userLabel(me),
      ttl: '3h',
      metadata: JSON.stringify({ avatarUrl: me?.avatarUrl || null }),
    });
    token.addGrant({ roomJoin: true, room: call.room, canPublish: true, canSubscribe: true });
    res.json({ url: lk.url, token: await token.toJwt(), groupCall: serializeGroupCall(call), started });
  })
);

/** I left the call: if nobody else is still in it, it ends. */
router.post(
  '/:id/group-call/leave',
  handle(async (req, res) => {
    const conv = await findConversationForUser(req.params.id, req.userId);
    if (!conv?.groupCall?.id) return res.json({ ended: true });
    const others = (await inRoom(conv.groupCall.room)).filter((p) => p.identity !== req.userId);
    if (others.length) return res.json({ ended: false });
    await endGroupCall(conv._id);
    res.json({ ended: true });
  })
);

/** Every minute: end group calls nobody is in any more (everyone dropped without leaving). */
export function startGroupCallSweeper() {
  if (!enabled()) return;
  setInterval(async () => {
    try {
      const active = await Conversation.find({ 'groupCall.id': { $type: 'string' } }, 'groupCall').lean();
      for (const c of active) {
        if (Date.now() - c.groupCall.startedAt < 60_000) continue;
        if (!(await inRoom(c.groupCall.room)).length) await endGroupCall(c._id);
      }
    } catch (err) {
      console.error('[api] group call sweep failed:', err.message);
    }
  }, 60_000).unref();
}

export default router;
