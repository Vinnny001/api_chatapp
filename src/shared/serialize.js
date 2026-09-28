import mongoose from 'mongoose';

// Shapes sent to clients. Both services use these so REST and socket payloads match exactly.

export const USER_FIELDS = 'name phone avatarUrl about lastSeen settings';
export const REPLY_POPULATE = { path: 'replyTo', select: 'sender type text media deletedForEveryone' };

export const isObjectId = (v) => v instanceof mongoose.Types.ObjectId;
export const idOf = (v) => (v == null ? null : String(v._id ?? v));
export const sameId = (a, b) => a != null && b != null && idOf(a) === idOf(b);

export function publicUser(u, { self = false } = {}) {
  if (!u) return null;
  if (isObjectId(u)) return { id: idOf(u) };
  const showLastSeen = u.settings?.showLastSeen !== false;
  const out = {
    id: idOf(u),
    name: u.name,
    phone: u.phone,
    avatarUrl: u.avatarUrl ?? null,
    about: u.about ?? '',
    lastSeen: showLastSeen || self ? u.lastSeen ?? null : null,
  };
  if (self) {
    out.email = u.email;
    out.gender = u.gender;
    out.settings = { showLastSeen };
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
    reactions: (m.reactions || []).map((r) => ({ user: idOf(r.user), emoji: r.emoji })),
    deletedForEveryone: deleted,
    editedAt: m.editedAt ?? null,
    expiresAt: m.expiresAt ?? null,
    createdAt: m.createdAt,
  };
  if (viewerId) out.starred = (m.starredBy || []).some((u) => sameId(u, viewerId));
  return out;
}

export function serializeConversation(c, viewerId) {
  const me = c.participants.find((p) => sameId(p.user, viewerId));
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
    participants: c.participants.map((p) => ({
      ...publicUser(p.user),
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
