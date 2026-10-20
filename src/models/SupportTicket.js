import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A request to ChatApp support (Help → Contact support), answered by the admins. Not end-to-end
 * encrypted: the support team has to read it (the app says so before it's sent).
 */
const supportTicketSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    topic: { type: String, enum: ['account', 'devices', 'messages', 'calls', 'groups', 'status', 'privacy', 'other'], default: 'other' },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    // open: waiting for support; answered: waiting for the user; closed
    state: { type: String, enum: ['open', 'answered', 'closed'], default: 'open', index: true },
    messages: [
      {
        _id: false,
        from: { type: String, enum: ['user', 'support'], required: true },
        author: { type: ObjectId, ref: 'User' },
        text: { type: String, required: true, maxlength: 4000 },
        at: { type: Date, default: Date.now },
      },
    ],
    device: { type: String, maxlength: 300 }, // the app / browser it was sent from, if the user shared it
    seenByUser: { type: Boolean, default: true }, // a reply the user hasn't opened yet
  },
  { timestamps: true }
);

export const SupportTicket = mongoose.models.SupportTicket || mongoose.model('SupportTicket', supportTicketSchema);
