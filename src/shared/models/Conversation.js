import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Per-member state. lastDeliveredAt / lastReadAt are watermarks: every message created at
// or before them counts as delivered / read by this member, which is how ticks are derived.
const participantSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
    lastDeliveredAt: { type: Date, default: Date.now },
    lastReadAt: { type: Date, default: Date.now },
    unreadCount: { type: Number, default: 0 },
    pinned: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    clearedAt: { type: Date, default: null },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    // Sorted "<userA>:<userB>" so there is only ever one direct chat per pair.
    directKey: { type: String, unique: true, sparse: true },
    participants: [participantSchema],
    name: { type: String, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    avatarUrl: { type: String, default: null },
    createdBy: { type: ObjectId, ref: 'User' },
    onlyAdminsCanSend: { type: Boolean, default: false },
    disappearingSeconds: { type: Number, default: 0 },
    lastMessage: { type: ObjectId, ref: 'Message', default: null },
    lastMessageAt: { type: Date, default: Date.now },
    // The latest reaction, shown in the chat list ("Ann reacted 👍 to: …") until a newer message.
    lastReaction: {
      type: {
        _id: false,
        user: { type: ObjectId, ref: 'User' },
        emoji: String,
        message: { type: ObjectId, ref: 'Message' },
        preview: String,
        at: Date,
      },
      default: null,
    },
  },
  { timestamps: true }
);

conversationSchema.index({ 'participants.user': 1, lastMessageAt: -1 });

conversationSchema.methods.member = function member(userId) {
  const id = String(userId);
  return this.participants.find((p) => String(p.user?._id ?? p.user) === id) || null;
};

export const Conversation =
  mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
