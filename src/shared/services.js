import { Conversation } from './models/Conversation.js';
import { Message } from './models/Message.js';
import { REPLY_POPULATE, USER_FIELDS, idOf, messagePreview, sameId, serializeReaction } from './serialize.js';

/** Query helper: a conversation with everything serializeConversation needs. */
export function withConversationRefs(query) {
  return query
    .populate('participants.user', USER_FIELDS)
    .populate({ path: 'lastMessage', populate: REPLY_POPULATE });
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
}) {
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
    });
  } catch (err) {
    if (err.code === 11000 && clientId) {
      const existing = await Message.findOne({ sender: senderId, clientId }).populate(REPLY_POPULATE);
      if (existing) return { message: existing, duplicate: true };
    }
    throw err;
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
  const update = countsAsUnread ? { $set: set, $inc: { 'participants.$[other].unreadCount': 1 } } : { $set: set };
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

export function createSystemMessage(conversation, text) {
  return createMessage({ conversation, type: 'system', text });
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
