import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { User } from './models/User.js';
import { idOf, messagePreview, serializeMessage } from './serialize.js';
import { userLabel } from './people.js';

// Push notifications through Firebase Cloud Messaging. Android gets *data-only* messages:
// the app builds WhatsApp-style notifications itself (messages stacked per chat with the
// sender's photo, Reply / Mark as read buttons, full-screen ringing for calls).
// Enabled when FIREBASE_SERVICE_ACCOUNT is set (the service-account JSON from Firebase
// console → Project settings → Service accounts, raw JSON or base64-encoded).

let messaging = null;

export function initPush() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) {
    console.log('[push] FIREBASE_SERVICE_ACCOUNT not set: push notifications are off');
    return;
  }
  try {
    const credentials = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    messaging = getMessaging(initializeApp({ credential: cert(credentials) }));
    console.log(`[push] enabled (Firebase project ${credentials.project_id})`);
  } catch (err) {
    console.error('[push] invalid FIREBASE_SERVICE_ACCOUNT, push notifications are off:', err.message);
  }
}

// Replies from FCM that mean "this token will never work again".
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/** Sends a data message (all values strings) to every registered phone of these users. */
async function pushData(userIds, data, { ttlSeconds = 4 * 7 * 24 * 3600, collapseKey } = {}) {
  if (!messaging || !userIds.length) return;
  const users = await User.find({ _id: { $in: userIds }, 'devices.0': { $exists: true } }, '+devices').lean();
  const tokens = users.flatMap((u) => (u.devices || []).map((d) => d.token)).filter(Boolean);
  if (!tokens.length) return;
  const payload = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)]));
  const result = await messaging.sendEachForMulticast({
    tokens,
    data: payload,
    android: { priority: 'high', ttl: ttlSeconds * 1000, ...(collapseKey && { collapseKey }) },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { contentAvailable: true } } },
  });
  const dead = result.responses
    .map((r, i) => (!r.success && DEAD_TOKEN.has(r.error?.code) ? tokens[i] : null))
    .filter(Boolean);
  if (dead.length) await User.updateMany({}, { $pull: { devices: { token: { $in: dead } } } });
}

const safely = (fn) => (...args) =>
  fn(...args).catch((err) => console.error('[push] failed:', err.message)); // never break sending

const previewOf = messagePreview;

/** New message → the other members' phones (not muted chats, not the sender). */
export const pushNewMessage = safely(async (message, conversation) => {
  if (message.type === 'system' || message.type === 'call') return;
  const senderId = idOf(message.sender);
  const recipientIds = conversation.participants
    .filter((p) => idOf(p.user) !== senderId && !p.muted)
    .map((p) => idOf(p.user));
  if (!recipientIds.length) return;
  const sender = await User.findById(senderId, 'username phone avatarUrl').lean();
  const isGroup = conversation.type === 'group';
  // The phone swaps in the name each recipient saved the sender under (it knows senderId);
  // otherwise it shows the username, or the number for people without one.
  const label = userLabel(sender);
  const data = {
    type: 'message',
    conversationId: idOf(conversation),
    messageId: idOf(message),
    isGroup: isGroup ? '1' : '0',
    chatTitle: isGroup ? conversation.name : label,
    chatAvatar: isGroup ? conversation.avatarUrl : sender?.avatarUrl,
    senderId,
    senderName: label,
    senderAvatar: sender?.avatarUrl,
    text: previewOf(message).slice(0, 500),
    sentAt: new Date(message.createdAt).getTime(),
  };
  // The whole message, so the app can show it straight away even if the phone is offline
  // when it's opened. Left out when it doesn't fit in a push (FCM allows 4 KB).
  const full = JSON.stringify(serializeMessage(message));
  if (Buffer.byteLength(JSON.stringify(data)) + Buffer.byteLength(full) < 3600) data.message = full;
  await pushData(recipientIds, data);
});

/** Someone reacted to my message: "Reacted 👍 to: …" (only the message's author is told). */
export const pushReaction = safely(async ({ message, conversation, reactorId, emoji, preview }) => {
  const authorId = idOf(message.sender);
  if (!authorId || authorId === reactorId) return;
  const author = conversation.participants.find((p) => idOf(p.user) === authorId);
  if (!author || author.muted) return;
  const reactor = await User.findById(reactorId, 'username phone avatarUrl').lean();
  const isGroup = conversation.type === 'group';
  const label = userLabel(reactor);
  await pushData([authorId], {
    type: 'reaction',
    conversationId: idOf(conversation),
    messageId: idOf(message),
    isGroup: isGroup ? '1' : '0',
    chatTitle: isGroup ? conversation.name : label,
    chatAvatar: isGroup ? conversation.avatarUrl : reactor?.avatarUrl,
    senderId: reactorId,
    senderName: label,
    senderAvatar: reactor?.avatarUrl,
    emoji,
    preview,
    // The phone writes "<name you saved> reacted 👍 to: …"; this is the fallback.
    text: `${label} reacted ${emoji} to: “${preview}”`,
    sentAt: Date.now(),
  });
});

/** The reaction was taken back: remove it from the author's notification. */
export const pushReactionRemoved = safely(async ({ message, conversation, reactorId }) => {
  const authorId = idOf(message.sender);
  if (!authorId || authorId === reactorId) return;
  await pushData(
    [authorId],
    { type: 'reaction_removed', conversationId: idOf(conversation), messageId: idOf(message), senderId: reactorId },
    { ttlSeconds: 24 * 3600 }
  );
});

/** You read a chat: clear its notification on your other phones. */
export const pushRead = safely(async (userId, conversationId) => {
  await pushData([userId], { type: 'read', conversationId }, { ttlSeconds: 24 * 3600 });
});

/** Incoming call → ring on the callee's phones (full-screen, Answer / Decline). */
export const pushIncomingCall = safely(async (calleeId, { callId, conversationId, kind, caller }) => {
  await pushData(
    [calleeId],
    {
      type: 'call',
      callId,
      conversationId,
      kind,
      callerId: caller.id,
      callerName: caller.name || 'Someone',
      callerAvatar: caller.avatarUrl,
      sentAt: Date.now(),
    },
    { ttlSeconds: 40 } // a call that couldn't be delivered in time must not ring later
  );
});

/** A group call started: ring every other member (they join, or it stops after a while). */
export const pushGroupCall = safely(async (memberIds, { callId, conversation, kind, starter }) => {
  await pushData(
    memberIds,
    {
      type: 'call',
      group: '1',
      callId,
      conversationId: idOf(conversation),
      kind,
      // The phone shows the group: "Team" with "@ann is calling the group".
      callerId: idOf(starter),
      callerName: conversation.name || 'Group',
      callerAvatar: conversation.avatarUrl,
      starterName: userLabel(starter),
      sentAt: Date.now(),
    },
    { ttlSeconds: 40 }
  );
});

/** The call stopped ringing (answered, declined, cancelled, timed out): stop the ringer. */
export const pushCallEnded = safely(async (calleeId, { callId, conversationId, kind, status, caller }) => {
  await pushData([calleeId], {
    type: 'call_end',
    callId,
    conversationId,
    kind,
    status, // 'missed' shows a "Missed call" notification
    group: caller.group ? '1' : '0',
    callerId: caller.id,
    callerName: caller.name || 'Someone',
    callerAvatar: caller.avatarUrl,
  });
});
