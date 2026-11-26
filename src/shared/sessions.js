import { readToken, tokenProblem } from './auth.js';
import { Device } from './models/Device.js';
import { User } from './models/User.js';

// A device counts as signed in while it has been used within the login lifetime (tokens
// last 90 days and are renewed while the app is used); older ones can't approve anything.
export const DEVICE_ACTIVE_MS = 90 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/**
 * Checks a login token against the database: the account exists and isn't disabled, the
 * token isn't older than the last "sign out everywhere", and its device hasn't been signed
 * out. Returns { userId, deviceId } (deviceId is null for tokens from before devices
 * existed; the app swaps those for a device token), or null.
 */
export async function authenticate(token) {
  return (await check(token)).session || null;
}

/**
 * Like authenticate, but says why not: { session } or { reason }, reason being 'expired'
 * (the sign-in ran out: the app keeps this device's chats), 'signed-out' (logged out here,
 * keeping its chats), 'revoked' (signed out from elsewhere, password changed) or 'invalid'.
 */
export async function check(token) {
  if (!token) return { reason: 'invalid' };
  const payload = readToken(token);
  if (!payload) return { reason: tokenProblem(token) || 'invalid' };
  const userId = payload.sub;
  const user = await User.findById(userId, 'disabled sessionsValidAfter').lean();
  if (!user || user.disabled) return { reason: 'revoked' };
  if (user.sessionsValidAfter && payload.iat * 1000 < user.sessionsValidAfter.getTime()) return { reason: 'revoked' };
  if (!payload.did) return { session: { userId, deviceId: null, historyFrom: null } };
  const device = await Device.findOne({ _id: payload.did, user: userId }, 'revokedAt signedOutAt lastActiveAt historyFrom').lean();
  if (!device || device.revokedAt) return { reason: 'revoked' };
  if (device.signedOutAt && payload.iat * 1000 <= device.signedOutAt.getTime()) return { reason: 'signed-out' };
  if (Date.now() - (device.lastActiveAt?.getTime() || 0) > TOUCH_EVERY_MS) {
    Device.updateOne({ _id: device._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
  }
  return { session: { userId, deviceId: String(device._id), historyFrom: device.historyFrom || null } };
}

/** Devices that can approve a new sign-in (not signed out, used recently). */
export function activeDevices(userId, { except } = {}) {
  return Device.find({
    user: userId,
    revokedAt: null,
    signedOutAt: null, // (logged out, keeping its chats)
    lastActiveAt: { $gt: new Date(Date.now() - DEVICE_ACTIVE_MS) },
    ...(except && { _id: { $ne: except } }),
  })
    .sort({ lastActiveAt: -1 })
    .lean();
}
