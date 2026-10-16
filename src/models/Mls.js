import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// End-to-end encryption plumbing (MLS, RFC 9420). Everything here is either public key
// material or ciphertext: the server orders and relays it, but can't read any message.

/** A one-time KeyPackage a device published so others can add it to a chat while it's offline. */
const keyPackageSchema = new mongoose.Schema(
  {
    device: { type: ObjectId, ref: 'Device', required: true, index: true },
    user: { type: ObjectId, ref: 'User', required: true },
    keyId: { type: String, required: true }, // the device's own name for it (finds the private half)
    data: { type: String, required: true }, // MLSMessage(KeyPackage), base64
    // The device's "last resort" KeyPackage (RFC 9420): handed out again and again, only when
    // its one-time ones have run out (a device that stayed away a long time).
    lastResort: { type: Boolean, default: undefined },
  },
  { timestamps: true }
);
export const KeyPackage = mongoose.models.KeyPackage || mongoose.model('KeyPackage', keyPackageSchema);

/**
 * The ordered key changes of a chat's encryption group: commit N moves epoch N to N+1. A device
 * that was offline replays them in order before reading newer messages.
 */
const mlsCommitSchema = new mongoose.Schema(
  {
    conversation: { type: ObjectId, ref: 'Conversation', required: true },
    epoch: { type: Number, required: true },
    device: { type: ObjectId, ref: 'Device', required: true },
    data: { type: String, required: true }, // MLSMessage(commit), base64
  },
  { timestamps: true }
);
mlsCommitSchema.index({ conversation: 1, epoch: 1 }, { unique: true });
// Kept a year: a device that was away (inactive devices stay in their chats until signed out)
// replays them to read what it missed.
const KEEP_SECONDS = 365 * 24 * 3600;
mlsCommitSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });
export const MlsCommit = mongoose.models.MlsCommit || mongoose.model('MlsCommit', mlsCommitSchema);

/** A Welcome for a device that was added to a chat's group, waiting until that device fetches it. */
const mlsWelcomeSchema = new mongoose.Schema(
  {
    device: { type: ObjectId, ref: 'Device', required: true, index: true },
    conversation: { type: ObjectId, ref: 'Conversation', required: true },
    epoch: { type: Number, required: true }, // the epoch it joins at
    keyId: { type: String, required: true },
    data: { type: String, required: true }, // MLSMessage(Welcome), base64
  },
  { timestamps: true }
);
mlsWelcomeSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });
export const MlsWelcome = mongoose.models.MlsWelcome || mongoose.model('MlsWelcome', mlsWelcomeSchema);

/** Databases made when these were kept 45 days: change the expiry in place (an index can't be redefined). */
export async function migrateMlsRetention() {
  for (const model of [MlsCommit, MlsWelcome]) {
    try {
      await model.db.db.command({ collMod: model.collection.collectionName, index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: KEEP_SECONDS } });
    } catch (err) {
      if (err.codeName !== 'NamespaceNotFound' && err.codeName !== 'IndexNotFound') console.warn('[mls] retention', err.message);
    }
  }
}

/**
 * A message on the encrypted channel between one user's own devices (history for a newly
 * linked device, address-book contacts). Ciphertext only; kept 30 days.
 */
const syncMessageSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    device: { type: ObjectId, ref: 'Device', required: true }, // the sender
    epoch: { type: Number, required: true },
    ciphertext: { type: String, required: true },
  },
  { timestamps: true }
);
syncMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export const SyncMessage = mongoose.models.SyncMessage || mongoose.model('SyncMessage', syncMessageSchema);
