import mongoose from 'mongoose';

// Shapes sent to clients. Both services use these so REST and socket payloads match exactly.

export const USER_FIELDS = 'username phone email avatarUrl about lastSeen settings';
export const REPLY_POPULATE = { path: 'replyTo', select: 'sender type text media deletedForEveryone' };

export const isObjectId = (v) => v instanceof mongoose.Types.ObjectId;
export const idOf = (v) => (v == null ? null : String(v._id ?? v));
export const sameId = (a, b) => a != null && b != null && idOf(a) === idOf(b);

/**
 * What others may see of a user. The registered name stays private (the app shows the name
 * the viewer saved them under, else the username, else the phone number). The phone number
 * is shared only by people without a username or who chose to show it; the email only when
 * the user chose to. People who already have the number (address book) get it on their device.
 */
export function publicUser(u, { self = false, hideLastSeen = false } = {}) {
  if (!u) return null;
  if (isObjectId(u)) return { id: idOf(u) };
  const showLastSeen = u.settings?.showLastSeen !== false;
  const showPhone = !!u.settings?.showPhone;
  const showEmail = !!u.settings?.showEmail;
  const out = {
    id: idOf(u),
    username: u.username || null,
    avatarUrl: u.avatarUrl ?? null,
    about: u.about ?? '',
    // Like WhatsApp, it goes both ways: hiding your last seen also hides everyone else's from you.
    lastSeen: self || (showLastSeen && !hideLastSeen) ? u.lastSeen ?? null : null,
  };
  if (self || !u.username || showPhone) out.phone = u.phone;
  if (self || showEmail) out.email = u.email;
  if (self) {
    out.name = u.name;
    out.emailVerified = u.emailVerified !== false;
    out.gender = u.gender;
    out.settings = { showLastSeen, showPhone, showEmail };
  }
  return out;
}

function replyPreview(r) {
  if (!r) return null;
  if (isObjectId(r)) return { id: idOf(r) };
  return {
    id: idOf(r),
    sender: idOf(r.sender),
    type: r.type,
    text: r.deletedForEveryone ? '' : (r.text || '').slice(0, 200),
    mediaName: r.deletedForEveryone ? undefined : r.media?.name,
    mediaUrl: !r.deletedForEveryone && r.type === 'image' ? r.media?.url : undefined,
    deletedForEveryone: !!r.deletedForEveryone,
  };
}

/**
 * viewerId is optional: without it the per-user "starred" flag is left out, so a payload
 * broadcast to a whole room never overwrites each client's own value.
 */
export function serializeMessage(m, viewerId) {
  if (!m) return null;
  const deleted = !!m.deletedForEveryone;
  const out = {
    id: idOf(m),
    conversationId: idOf(m.conversation),
    sender: idOf(m.sender),
    clientId: m.clientId ?? null,
    type: m.type,
    text: deleted ? '' : m.text || '',
    media: deleted || !m.media?.url ? null : { ...(m.media.toObject?.() ?? m.media) },
    replyTo: replyPreview(m.replyTo),
    forwarded: !!m.forwarded,
    call: m.call?.kind
      ? {
          kind: m.call.kind,
          status: m.call.status,
          duration: m.call.duration || 0,
          ...(m.call.group && { group: true, participants: (m.call.participants || []).map(idOf) }),
        }
      : null,
    reactions: (m.reactions || []).map((r) => ({ user: idOf(r.user), emoji: r.emoji })),
    deletedForEveryone: deleted,
    editedAt: m.editedAt ?? null,
    expiresAt: m.expiresAt ?? null,
    createdAt: m.createdAt,
  };
  if (viewerId) out.starred = (m.starredBy || []).some((u) => sameId(u, viewerId));
  return out;
}

const MEDIA_LABELS = { image: '📷 Photo', video: '🎥 Video', voice: '🎤 Voice message', audio: '🎵 Audio' };

/** One-line description of a message (notifications, "reacted to …"). */
export function messagePreview(message) {
  if (!message) return '';
  if (message.type === 'text' || message.type === 'system') return message.text || '';
  if (message.type === 'file') return `📄 ${message.media?.name || 'Document'}`;
  if (message.type === 'call') return message.call?.kind === 'video' ? '📹 Video call' : '📞 Voice call';
  const label = MEDIA_LABELS[message.type] || 'Message';
  return message.text ? `${label}: ${message.text}` : label;
}

/** A group call in progress (the LiveKit room name stays on the server). */
export function serializeGroupCall(g) {
  if (!g?.id) return null;
  return { id: g.id, kind: g.kind, startedBy: idOf(g.startedBy), startedAt: g.startedAt, joined: (g.joined || []).map(idOf) };
}

export function serializeReaction(r) {
  if (!r?.user) return null;
  return { user: idOf(r.user), emoji: r.emoji, messageId: idOf(r.message), preview: r.preview || '', at: r.at };
}

export function serializeConversation(c, viewerId) {
  const me = c.participants.find((p) => sameId(p.user, viewerId));
  const viewerHidesLastSeen = me?.user?.settings?.showLastSeen === false;
  const last = c.lastMessage && !isObjectId(c.lastMessage) ? c.lastMessage : null;
  const since = me ? Math.max(+me.joinedAt || 0, +me.clearedAt || 0) : 0;
  const lastVisible =
    last && +last.createdAt >= since && !(last.deletedFor || []).some((u) => sameId(u, viewerId));

  return {
    id: idOf(c),
    type: c.type,
    name: c.name ?? null,
    description: c.description ?? '',
    avatarUrl: c.avatarUrl ?? null,
    createdBy: idOf(c.createdBy),
    onlyAdminsCanSend: !!c.onlyAdminsCanSend,
    disappearingSeconds: c.disappearingSeconds || 0,
    lastReaction: serializeReaction(c.lastReaction),
    groupCall: serializeGroupCall(c.groupCall),
    participants: c.participants.map((p) => ({
      ...publicUser(p.user, { hideLastSeen: viewerHidesLastSeen && !sameId(p.user, viewerId) }),
      role: p.role,
      joinedAt: p.joinedAt,
      lastDeliveredAt: p.lastDeliveredAt,
      lastReadAt: p.lastReadAt,
    })),
    lastMessage: lastVisible ? serializeMessage(last, viewerId) : null,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    me: me
      ? {
          role: me.role,
          pinned: !!me.pinned,
          muted: !!me.muted,
          archived: !!me.archived,
          unreadCount: me.unreadCount || 0,
          joinedAt: me.joinedAt,
          clearedAt: me.clearedAt ?? null,
        }
      : null,
  };
}
