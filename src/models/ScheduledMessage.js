import mongoose from 'mongoose';

// A message to send later. It's encrypted on the sender's phone when it's scheduled (the
// server never sees its content); at `sendAt` the API sends it like any other message.
const scheduledMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    device: { type: String, required: true }, // the device that encrypted it
    sendAt: { type: Date, required: true },
    body: { type: mongoose.Schema.Types.Mixed, required: true }, // what POST /messages takes
    state: { type: String, enum: ['pending', 'sending', 'failed'], default: 'pending' },
    error: { type: String, default: null },
  },
  { timestamps: true }
);
scheduledMessageSchema.index({ state: 1, sendAt: 1 });

export const ScheduledMessage =
  mongoose.models.ScheduledMessage || mongoose.model('ScheduledMessage', scheduledMessageSchema);
