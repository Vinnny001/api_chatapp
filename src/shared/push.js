import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { User } from './models/User.js';
import { idOf } from './serialize.js';

// Push notifications through Firebase Cloud Messaging, so phones are told about new messages
// even when the app is in the background or closed. Enabled when FIREBASE_SERVICE_ACCOUNT is
// set (the service-account JSON from Firebase console → Project settings → Service accounts,
// either as raw JSON or base64-encoded).

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

const LABELS = { image: '📷 Photo', video: '🎥 Video', voice: '🎤 Voice message', audio: '🎵 Audio' };

function previewOf(message) {
  if (message.type === 'text') return message.text;
  if (message.type === 'file') return `📄 ${message.media?.name || 'Document'}`;
  const label = LABELS[message.type] || 'New message';
  return message.text ? `${label}: ${message.text}` : label;
}

// Replies from FCM that mean "this token will never work again".
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/**
 * Notifies every other member's phones about a new message (not muted chats, not the
 * sender). High priority + the "messages" channel makes Android show it as a heads-up
 * pop-up. Never throws: a push problem must not affect sending.
 */
export async function pushNewMessage(message, conversation) {
  if (!messaging || message.type === 'system') return;
  try {
    const senderId = idOf(message.sender);
    const recipientIds = conversation.participants
      .filter((p) => idOf(p.user) !== senderId && !p.muted)
      .map((p) => idOf(p.user));
    if (!recipientIds.length) return;

    const [sender, recipients] = await Promise.all([
      User.findById(senderId, 'name').lean(),
      User.find({ _id: { $in: recipientIds }, 'devices.0': { $exists: true } }, '+devices').lean(),
    ]);
    const tokens = recipients.flatMap((u) => (u.devices || []).map((d) => d.token)).filter(Boolean);
    if (!tokens.length) return;

    const senderName = sender?.name || 'Someone';
    const title = conversation.type === 'group' ? `${senderName} @ ${conversation.name}` : senderName;
    const conversationId = idOf(conversation);
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body: previewOf(message).slice(0, 200) },
      data: { type: 'message', conversationId, messageId: idOf(message) },
      android: {
        priority: 'high',
        notification: {
          channelId: 'messages',
          icon: 'ic_stat_chat',
          color: '#0b8f6a',
          sound: 'default',
          tag: conversationId, // one notification per chat, updated as messages arrive
          defaultVibrateTimings: true,
        },
      },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', threadId: conversationId } } },
    });

    const dead = result.responses
      .map((r, i) => (!r.success && DEAD_TOKEN.has(r.error?.code) ? tokens[i] : null))
      .filter(Boolean);
    if (dead.length) await User.updateMany({}, { $pull: { devices: { token: { $in: dead } } } });
  } catch (err) {
    console.error('[push] failed:', err.message);
  }
}
