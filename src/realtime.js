// The API never holds sockets. It sends instructions ("emit X to these rooms", "put these
// users' sockets in room Y") to the realtime service's private HTTP endpoint.
// Operations queued in the same tick go out as one request, and requests are sent one
// after another so the realtime service always applies them in order.
import {
  Conversation,
  EVENTS,
  INTERNAL_EVENTS_PATH,
  config,
  idOf,
  rooms,
  serializeConversation,
  serializeMessage,
  withConversationRefs,
} from '#shared';

let queue = [];
let flushScheduled = false;
let sending = Promise.resolve();

function push(op) {
  queue.push(op);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    const ops = queue;
    queue = [];
    sending = sending.then(() => send(ops));
  });
}

async function send(ops) {
  try {
    const res = await fetch(config.realtimeInternalUrl + INTERNAL_EVENTS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': config.internalSecret },
      body: JSON.stringify({ ops }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`[api] realtime rejected ${ops.length} event(s): HTTP ${res.status}`);
  } catch (err) {
    // Clients resync over REST when they reconnect, so a missed live event is not data loss.
    console.error(`[api] could not reach realtime service: ${err.message}`);
  }
}

export function emitToUser(userId, event, payload) {
  push({ op: 'emit', rooms: [rooms.user(userId)], event, data: payload });
}

export function emitToConversations(conversationIds, event, payload) {
  if (conversationIds.length) push({ op: 'emit', rooms: conversationIds.map(rooms.conv), event, data: payload });
}

/** Sends every member their own view of the conversation, subscribing new members' sockets first. */
export async function broadcastConversation(conversationId, { join = [] } = {}) {
  const conv = await withConversationRefs(Conversation.findById(conversationId));
  if (!conv) return null;
  if (join.length) push({ op: 'join', rooms: join.map((id) => rooms.user(idOf(id))), room: rooms.conv(conv._id) });
  for (const p of conv.participants) {
    const userId = idOf(p.user);
    emitToUser(userId, EVENTS.CONVERSATION_UPSERT, serializeConversation(conv, userId));
  }
  return conv;
}

export function removeUserFromConversation(conversationId, userId) {
  push({ op: 'leave', rooms: [rooms.user(userId)], room: rooms.conv(conversationId) });
  emitToUser(userId, EVENTS.CONVERSATION_REMOVED, { conversationId: idOf(conversationId) });
}

/** Emits to every member's personal room, so it works even before they joined the conv room. */
export function broadcastMessage(message, conversation) {
  const targets = conversation.participants.map((p) => rooms.user(idOf(p.user)));
  if (targets.length) push({ op: 'emit', rooms: targets, event: EVENTS.MESSAGE_NEW, data: serializeMessage(message) });
}
