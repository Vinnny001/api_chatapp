import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A signed-in device (phone, browser). Every login token names its device, so a device can be
 * signed out on its own (Linked devices, or "this wasn't me" in the new-sign-in email).
 * Later the device also holds its end-to-end encryption identity.
 */
const deviceSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, trim: true, maxlength: 80, default: 'Unknown device' },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'web' },
    // How it was let in: the first device, approved on another device, an emailed code,
    // a password reset, sign-up, or a session from before devices existed.
    approvedBy: { type: String, enum: ['first', 'device', 'email', 'reset', 'signup', 'legacy'], required: true },
    approver: { type: ObjectId, ref: 'Device', default: undefined },
    ip: { type: String, default: undefined },
    lastActiveAt: { type: Date, default: Date.now },
    pushToken: { type: String, default: undefined }, // this device's FCM token, removed with it
    // End-to-end encryption identity: the device's MLS signature public key (base64). Set
    // once; a device never changes it (a new key means a new device).
    mlsKey: { type: String, default: undefined },
    // Sync with my other devices (history + contacts)? Undecided until the user chooses on a
    // new device. Not syncing: this device sees only messages from `historyFrom` (its sign-in) on.
    sync: { type: Boolean, default: undefined },
    historyFrom: { type: Date, default: undefined },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

deviceSchema.index({ user: 1, revokedAt: 1, lastActiveAt: -1 });

export const Device = mongoose.models.Device || mongoose.model('Device', deviceSchema);
