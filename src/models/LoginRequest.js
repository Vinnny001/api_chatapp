import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A sign-in on a new device waiting for approval: from one of the account's signed-in
 * devices (tapping the matching number) or with a code sent to the account's email.
 * Only the new device knows `secret` (stored hashed), so only it can collect the login.
 */
const loginRequestSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    secretHash: { type: String, required: true },
    name: { type: String, maxlength: 80 },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'web' },
    ip: String,
    // Shown on the new device; the approving device must pick it out of three numbers, so a
    // request can't be approved by mistake (or by tapping a request someone else started).
    match: { type: Number, min: 10, max: 99, required: true },
    status: { type: String, enum: ['pending', 'approved', 'denied', 'used'], default: 'pending' },
    method: { type: String, enum: ['device', 'email'], default: undefined },
    approver: { type: ObjectId, ref: 'Device', default: undefined },
    emailCode: {
      type: { _id: false, hash: String, attempts: Number, sentAt: Date },
      default: undefined,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// MongoDB deletes requests an hour after they expire.
loginRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const LoginRequest = mongoose.models.LoginRequest || mongoose.model('LoginRequest', loginRequestSchema);
