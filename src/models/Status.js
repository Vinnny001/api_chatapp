import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A status update (text, photo or video for 24 hours). End-to-end encrypted: `content` is the
 * update sealed with a one-time key, and that key is sealed again for each device allowed to
 * see it (`envelopes`, one per device). The server can't read either, and a viewer only ever
 * gets the envelope for their own device, so nobody learns who else can see it.
 */
const statusSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    content: { type: String, required: true }, // base64: iv (12 bytes) + AES-GCM ciphertext
    envelopes: [{ _id: false, device: { type: ObjectId, ref: 'Device', required: true }, data: { type: String, required: true } }],
    audience: { type: [{ type: ObjectId, ref: 'User' }], index: true }, // who may see it (the author's privacy then)
    views: { type: [{ _id: false, user: { type: ObjectId, ref: 'User' }, at: Date }], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
statusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // gone after 24 hours

export const Status = mongoose.models.Status || mongoose.model('Status', statusSchema);
