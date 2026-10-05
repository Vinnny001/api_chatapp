import mongoose from 'mongoose';
import { Conversation } from './models/Conversation.js';
import { Message } from './models/Message.js';
import { User } from './models/User.js';
import { MENTION_TOKEN, REPLY_POPULATE, USER_FIELDS, idOf, messagePreview, sameId, serializeReaction } from './serialize.js';

/** Query helper: a conversation with everything serializeConversation needs. */
export function withConversationRefs(query) {
  return query
    .populate('participants.user', USER_FIELDS)
    .populate({ path: 'lastMessage', populate: REPLY_POPULATE })
    .populate({ path: 'pinned.message', select: 'sender type text media call deletedForEveryone' });
}

export function findConversationForUser(conversationId, userId) {
  return Conversation.findOne({ _id: conversationId, 'participants.user': userId });
}

export function canSend(conversation, userId) {
  const member = conversation.member(userId);
  if (!member) return false;
  return !(conversation.type === 'group' && conversation.onlyAdminsCanSend && member.role !== 'admin');
}

/**
 * Stores a message and updates the conversation's last message and unread counters.
 * A repeated clientId from the same sender returns the original message instead of a copy.
 */
export async function createMessage({
  conversation,
  senderId = null,
  type = 'text',
  text = '',
  media,
  replyTo = null,
  forwarded = false,
  clientId,
  call,
  countsAsUnread = true, // false for call log entries the recipient already saw (answered/declined)
  hiddenFrom = [], // people who must never see it (they blocked the sender)
}) {
  // @mentions: only members of this group, never the sender.
  const members = new Set(conversation.participants.map((p) => idOf(p.user)));
  const mentions =
    conversation.type === 'group' && text
      ? [...new Set([...text.matchAll(MENTION_TOKEN)].map((m) => m[2]))].filter((id) => members.has(id) && id !== idOf(senderId))
      : [];
  const expiresAt =
    conversation.disappearingSeconds > 0
      ? new Date(Date.now() + conversation.disappearingSeconds * 1000)
      : undefined;

  let message;
  try {
    message = await Message.create({
      conversation: conversation._id,
      sender: senderId,
      clientId,
      type,
      text,
      media,
      replyTo,
      forwarded,
      call,
      expiresAt,
      ...(mentions.length && { mentions }),
      ...(hiddenFrom.length && { deletedFor: hiddenFrom }),
    });
  } catch (err) {
    if (err.code === 11000 && clientId) {
      const existing = await Message.findOne({ sender: senderId, clientId }).populate(REPLY_POPULATE);
      if (existing) return { message: existing, duplicate: true };
    }
    throw err;
  }

  // A message the other person never sees (blocked) doesn't move the chat or count as unread.
  if (hiddenFrom.length) {
    if (replyTo) await message.populate(REPLY_POPULATE);
    return { message, duplicate: false };
  }

  const set = { lastMessage: message._id, lastMessageAt: message.createdAt, lastReaction: null };
  const arrayFilters = [{ 'other.user': { $ne: senderId } }];
  if (senderId) {
    // Sending implies the sender has seen everything before it.
    set['participants.$[me].lastReadAt'] = message.createdAt;
    set['participants.$[me].lastDeliveredAt'] = message.createdAt;
    set['participants.$[me].unreadCount'] = 0;
    arrayFilters.push({ 'me.user': senderId });
  }
  const inc = countsAsUnread ? { 'participants.$[other].unreadCount': 1 } : {};
  if (mentions.length) {
    inc['participants.$[mentioned].unreadMentions'] = 1;
    arrayFilters.push({ 'mentioned.user': { $in: mentions.map((id) => new mongoose.Types.ObjectId(id)) } });
  }
  const update = Object.keys(inc).length ? { $set: set, $inc: inc } : { $set: set };
  await Conversation.updateOne({ _id: conversation._id }, update, {
    arrayFilters: countsAsUnread ? arrayFilters : arrayFilters.filter((f) => !('other.user' in f)),
  });

  if (replyTo) await message.populate(REPLY_POPULATE);
  return { message, duplicate: false };
}

/**
 * React to a message (one reaction per person, like WhatsApp): a new emoji replaces mine,
 * the same emoji again (or null) removes it. Returns the patch to broadcast and what happened.
 */
export async function reactToMessage({ messageId, userId, emoji }) {
  const message = await Message.findById(messageId);
  const conversation = message && (await findConversationForUser(message.conversation, userId));
  if (!conversation) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (message.deletedForEveryone || message.type === 'system' || message.type === 'call') {
    throw Object.assign(new Error('You can’t react to this message'), { status: 400 });
  }
  const previous = message.reactions.find((r) => sameId(r.user, userId));
  const adding = !!emoji && emoji !== previous?.emoji;
  // Atomic, so two people reacting at the same moment never overwrite each other.
  await Message.updateOne({ _id: message._id }, { $pull: { reactions: { user: userId } } });
  if (adding) await Message.updateOne({ _id: message._id }, { $push: { reactions: { user: userId, emoji } } });
  const fresh = await Message.findById(message._id, 'reactions').lean();

  const patch = {
    id: idOf(message),
    conversationId: idOf(conversation),
    reactions: (fresh?.reactions || []).map((r) => ({ user: idOf(r.user), emoji: r.emoji })),
  };
  const preview = messagePreview(message).slice(0, 80);
  if (adding) {
    const lastReaction = { user: userId, emoji, message: message._id, preview, at: new Date() };
    await Conversation.updateOne({ _id: conversation._id }, { $set: { lastReaction } });
    // `author` (who wrote the message) lets the author's app play a sound / notify.
    patch.lastReaction = { ...serializeReaction(lastReaction), author: idOf(message.sender) };
  } else if (previous) {
    const cleared = await Conversation.updateOne(
      { _id: conversation._id, 'lastReaction.user': userId, 'lastReaction.message': message._id },
      { $set: { lastReaction: null } }
    );
    if (cleared.modifiedCount) patch.lastReaction = null;
  }
  return { message, conversation, patch, added: adding ? emoji : null, removed: !adding && !!previous, preview };
}

/**
 * One-to-one chats: has either person blocked the other? (Groups aren't affected, as on WhatsApp.)
 * { peerId, iBlocked: I blocked them, blockedMe: they blocked me }
 */
export async function blockStatus(conversation, userId) {
  const none = { peerId: null, iBlocked: false, blockedMe: false };
  if (conversation.type !== 'direct') return none;
  const peerId = conversation.participants.map((p) => idOf(p.user)).find((id) => id !== String(userId));
  if (!peerId) return none;
  const [me, them] = await Promise.all([User.findById(userId, 'blocked').lean(), User.findById(peerId, 'blocked').lean()]);
  return {
    peerId,
    iBlocked: (me?.blocked || []).some((id) => String(id) === peerId),
    blockedMe: (them?.blocked || []).some((id) => String(id) === String(userId)),
  };
}

/** Ids of the people who blocked this user (for hiding their presence from them). */
export async function blockedBy(userId) {
  const users = await User.find({ blocked: userId }, '_id').lean();
  return users.map((u) => String(u._id));
}

export function createSystemMessage(conversation, text) {
  return createMessage({ conversation, type: 'system', text });
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
