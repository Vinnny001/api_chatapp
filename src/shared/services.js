import { Conversation } from './models/Conversation.js';
import { Message } from './models/Message.js';
import { REPLY_POPULATE, USER_FIELDS } from './serialize.js';

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

  const set = { lastMessage: message._id, lastMessageAt: message.createdAt };
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

export function createSystemMessage(conversation, text) {
  return createMessage({ conversation, type: 'system', text });
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
