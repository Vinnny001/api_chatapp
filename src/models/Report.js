import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// A user reported by another user, for the admin page to review.
const reportSchema = new mongoose.Schema(
  {
    reporter: { type: ObjectId, ref: 'User', required: true },
    reported: { type: ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['spam', 'harassment', 'scam', 'inappropriate', 'impersonation', 'other'], default: 'other' },
    details: { type: String, maxlength: 500 },
    conversation: { type: ObjectId, ref: 'Conversation' },
    // Their last messages in that chat when the report was made.
    messages: [{ _id: false, type: { type: String }, text: String, mediaUrl: String, at: Date }],
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open' },
    reviewedBy: { type: ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, createdAt: -1 });

export const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);
