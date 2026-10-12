import jwt from 'jsonwebtoken';
import { Device, User, config, signToken } from '#shared';
import { newDeviceEmail, sendEmail } from './email.js';
import { disconnectDevices } from './realtime.js';
import { announceRoster } from './routes/mls.js';

/** What the app shows in Linked devices. */
export function deviceView(d, currentId) {
  return {
    id: String(d._id),
    name: d.name,
    platform: d.platform,
    approvedBy: d.approvedBy,
    createdAt: d.createdAt,
    lastActiveAt: d.lastActiveAt,
    current: String(d._id) === String(currentId),
  };
}

/** The client's IP (Render sits behind a proxy; app.js trusts the first hop). */
export const clientIp = (req) => (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || undefined;

/** The API's public address, for links in emails. */
export const publicBase = (req) => process.env.PUBLIC_API_URL?.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

/**
 * Registers a device and returns its login token. With `alert`, the account gets the
 * "new sign-in" email (with a link that signs this device out).
 */
export async function startSession(user, { name, platform, ip, approvedBy, approver, req, alert = true }) {
  const device = await Device.create({ user: user._id, name, platform, ip, approvedBy, approver, lastActiveAt: new Date() });
  if (alert) {
    sendNewDeviceEmail(user, device, req).catch((err) => console.error('[api] new-device email failed:', err.message));
  }
  return { device, token: signToken(user._id, { deviceId: device._id }) };
}

/** Signs devices out: their tokens stop working and their open connections are closed. */
export async function revokeDevices(userId, deviceIds) {
  if (!deviceIds.length) return;
  const devices = await Device.find({ _id: { $in: deviceIds }, user: userId, revokedAt: null }, 'pushToken').lean();
  if (!devices.length) return;
  await Device.updateMany({ _id: { $in: devices.map((d) => d._id) } }, { $set: { revokedAt: new Date() } });
  // Their phones stop getting this account's notifications.
  const tokens = devices.map((d) => d.pushToken).filter(Boolean);
  if (tokens.length) await User.updateOne({ _id: userId }, { $pull: { devices: { token: { $in: tokens } } } });
  disconnectDevices(devices.map((d) => d._id));
  // Chats re-check their encryption groups: the next message removes these devices.
  announceRoster(userId).catch(() => {});
}

/** Everything but `keep`, including tokens from before devices existed. */
export async function revokeOtherDevices(userId, keep) {
  const others = await Device.find({ user: userId, revokedAt: null, _id: { $ne: keep } }, '_id').lean();
  await revokeDevices(userId, others.map((d) => d._id));
  // Tokens issued before this moment stop working, except the kept device's own new one.
  await User.updateOne({ _id: userId }, { $set: { sessionsValidAfter: new Date(Date.now() - 1000) } });
}

// "This wasn't me" links: signed, single-device, valid for a week.
export const revokeLinkToken = (userId, deviceId) =>
  jwt.sign({ sub: String(userId), did: String(deviceId), purpose: 'revoke-device' }, config.jwtSecret, { expiresIn: '7d' });

export function readRevokeLink(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return p.purpose === 'revoke-device' ? { userId: p.sub, deviceId: p.did } : null;
  } catch {
    return null;
  }
}

async function sendNewDeviceEmail(user, device, req) {
  const link = `${publicBase(req)}/devices/revoke/${revokeLinkToken(user._id, device._id)}`;
  await sendEmail({ to: user.email, ...newDeviceEmail({ name: device.name, at: device.createdAt, ip: device.ip, method: device.approvedBy, link }) });
}
