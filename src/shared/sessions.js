import { readToken } from './auth.js';
import { Device } from './models/Device.js';
import { User } from './models/User.js';

// A device counts as signed in while it has been used within the login lifetime (tokens
// last 30 days); older ones can't approve anything, and their tokens have expired anyway.
export const DEVICE_ACTIVE_MS = 30 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/**
 * Checks a login token against the database: the account exists and isn't disabled, the
 * token isn't older than the last "sign out everywhere", and its device hasn't been signed
 * out. Returns { userId, deviceId } (deviceId is null for tokens from before devices
 * existed; the app swaps those for a device token), or null.
 */
export async function authenticate(token) {
  const payload = token && readToken(token);
  if (!payload) return null;
  const userId = payload.sub;
  const user = await User.findById(userId, 'disabled sessionsValidAfter').lean();
  if (!user || user.disabled) return null;
  if (user.sessionsValidAfter && payload.iat * 1000 < user.sessionsValidAfter.getTime()) return null;
  if (!payload.did) return { userId, deviceId: null };
  const device = await Device.findOne({ _id: payload.did, user: userId }, 'revokedAt lastActiveAt').lean();
  if (!device || device.revokedAt) return null;
  if (Date.now() - (device.lastActiveAt?.getTime() || 0) > TOUCH_EVERY_MS) {
    Device.updateOne({ _id: device._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
  }
  return { userId, deviceId: String(device._id) };
}

/** Devices that can approve a new sign-in (not signed out, used recently). */
export function activeDevices(userId, { except } = {}) {
  return Device.find({
    user: userId,
    revokedAt: null,
    lastActiveAt: { $gt: new Date(Date.now() - DEVICE_ACTIVE_MS) },
    ...(except && { _id: { $ne: except } }),
  })
    .sort({ lastActiveAt: -1 })
    .lean();
}
