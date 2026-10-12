import { Router } from 'express';
import { z } from 'zod';
import { Device, User, activeDevices, signToken } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { LoginRequest } from '../models/LoginRequest.js';
import { deviceView, revokeDevices, revokeOtherDevices, startSession } from '../devices.js';
import { announceRequestDone, requestView } from './auth.js';

const router = Router();

/** Linked devices: everything signed in to this account. */
router.get(
  '/',
  handle(async (req, res) => {
    const devices = await activeDevices(req.userId);
    res.json({ devices: devices.map((d) => deviceView(d, req.deviceId)), current: req.deviceId });
  })
);

/**
 * This device: sync with my other devices or not. Not syncing (chosen on a new device) means
 * it only sees messages from when it signed in; turning sync on later shows everything again
 * (and the device then asks my other devices for the encrypted history).
 */
router.patch(
  '/me',
  handle(async (req, res) => {
    if (!req.deviceId) throw new HttpError(400, 'Update the app first');
    const { sync } = z.object({ sync: z.boolean() }).parse(req.body);
    const device = await Device.findById(req.deviceId);
    const everSynced = device.sync === true;
    device.sync = sync;
    if (sync) device.historyFrom = undefined;
    // Only a device that never synced starts from its sign-in (what's already here stays).
    else if (!everSynced && !device.historyFrom) device.historyFrom = device.createdAt;
    await device.save();
    res.json({ device: deviceView(device, req.deviceId) });
  })
);

/** Sign a device out (this one too: that's "Sign out"). */
router.delete(
  '/:id',
  handle(async (req, res) => {
    const id = z.string().regex(/^[a-f0-9]{24}$/).parse(req.params.id);
    if (!(await Device.exists({ _id: id, user: req.userId }))) throw new HttpError(404, 'Device not found');
    await revokeDevices(req.userId, [id]);
    res.json({ ok: true });
  })
);

/** Sign out every other device. This device gets a fresh login (older tokens stop working). */
router.post(
  '/revoke-others',
  handle(async (req, res) => {
    if (!req.deviceId) throw new HttpError(400, 'Update the app first');
    await revokeOtherDevices(req.userId, req.deviceId);
    res.json({ ok: true, token: signToken(req.userId, { deviceId: req.deviceId }) });
  })
);

/**
 * A session from before devices existed registers itself as a device (once, automatically
 * when the updated app starts), so it shows in Linked devices and can approve new ones.
 */
router.post(
  '/register',
  handle(async (req, res) => {
    if (req.deviceId) return res.json({ ok: true });
    const { name, platform } = z
      .object({ name: z.string().trim().max(80).optional(), platform: z.enum(['android', 'ios', 'web']).optional() })
      .parse(req.body || {});
    const user = await User.findById(req.userId);
    const { token } = await startSession(user, {
      name: name || 'Unknown device',
      platform: platform || 'web',
      ip: req.ip,
      approvedBy: 'legacy',
      req,
      alert: false,
    });
    res.json({ token });
  })
);

/** Sign-in requests waiting for this account's approval. */
router.get(
  '/requests',
  handle(async (req, res) => {
    const requests = await LoginRequest.find({ user: req.userId, status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    res.json({ requests: requests.map(requestView) });
  })
);

/** Approve (tapping the number shown on the new device) or deny a sign-in. */
router.post(
  '/requests/:id',
  handle(async (req, res) => {
    const { approve, match } = z.object({ approve: z.boolean(), match: z.number().int().optional() }).parse(req.body);
    if (!req.deviceId) throw new HttpError(400, 'Update the app first');
    const request = /^[a-f0-9]{24}$/.test(req.params.id) ? await LoginRequest.findOne({ _id: req.params.id, user: req.userId }) : null;
    if (!request) throw new HttpError(404, 'Sign-in request not found');
    if (request.status !== 'pending' || request.expiresAt < new Date()) throw new HttpError(410, 'This sign-in request is no longer waiting');
    const right = approve && match === request.match;
    const answered = await LoginRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending' },
      { $set: right ? { status: 'approved', method: 'device', approver: req.deviceId } : { status: 'denied' } },
      { new: true }
    );
    if (!answered) throw new HttpError(410, 'This sign-in request was already answered');
    announceRequestDone(answered);
    // Picking the wrong number denies it: someone may be trying to trick you into approving.
    if (approve && !right) throw new HttpError(400, 'That number doesn’t match the new device, so the sign-in was blocked.');
    res.json({ ok: true, status: answered.status });
  })
);

export default router;
