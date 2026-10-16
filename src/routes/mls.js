import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Conversation, Device, EVENTS, Message, findConversationForUser, sameId } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { KeyPackage, MlsCommit, MlsWelcome, SyncMessage } from '../models/Mls.js';
import { broadcastConversation, emitToConversations, emitToDevices, emitToUser } from '../realtime.js';

// End-to-end encryption (MLS) delivery service. The server:
//   - keeps each device's signature public key (its encryption identity),
//   - hands out one-time KeyPackages so devices can be added while offline,
//   - orders each chat's key changes: exactly one commit per epoch, others are told to catch up,
//   - stores the public GroupInfo devices join with by themselves,
//   - relays Welcomes to the devices that were added.
// It never sees a key that decrypts anything.

const router = Router();
const b64 = z.string().min(16).max(400_000).regex(/^[A-Za-z0-9+/=]+$/);
const MAX_KEY_PACKAGES = 100;

function needDevice(req) {
  if (!req.deviceId) throw new HttpError(400, 'Update ChatApp to use encryption');
}

/**
 * Who should be able to read a chat: every encryption-capable device of every member that isn't
 * signed out, however long it has been away (it reads what it missed when it's back).
 * `ready` = every member has at least one such device.
 */
export async function rosterOf(conv) {
  const users = conv.participants.map((p) => p.user);
  const devices = await Device.find({ user: { $in: users }, revokedAt: null, mlsKey: { $exists: true } }, 'user mlsKey').lean();
  return {
    users: users.map(String),
    ready: users.every((u) => devices.some((d) => sameId(d.user, u))),
    devices: devices.map((d) => ({ userId: String(d.user), deviceId: String(d._id), key: d.mlsKey })),
  };
}

/** Tells the chats of these users that their set of devices changed (re-check before sending). */
export async function announceRoster(userId) {
  const convs = await Conversation.find({ 'participants.user': userId }, '_id').lean();
  emitToConversations(convs.map((c) => c._id), EVENTS.MLS_ROSTER, { userId: String(userId) });
}

async function memberConv(req, id = req.params.id) {
  const conv = mongoose.isValidObjectId(id) ? await findConversationForUser(id, req.userId) : null;
  if (!conv) throw new HttpError(404, 'Conversation not found');
  return conv;
}

/** This device's encryption identity (set once). */
router.post(
  '/identity',
  handle(async (req, res) => {
    needDevice(req);
    const { key } = z.object({ key: z.string().min(40).max(200).regex(/^[A-Za-z0-9+/=]+$/) }).parse(req.body);
    const device = await Device.findById(req.deviceId, 'mlsKey');
    if (device.mlsKey && device.mlsKey !== key) throw new HttpError(409, 'This device already has an encryption key');
    if (!device.mlsKey) {
      await Device.updateOne({ _id: req.deviceId }, { $set: { mlsKey: key }, $unset: { mlsError: 1 } });
      announceRoster(req.userId).catch(() => {});
    }
    res.json({ ok: true });
  })
);

/** The app couldn't start encryption on this device: keep the reason (support / diagnosis). */
router.post(
  '/diagnostic',
  handle(async (req, res) => {
    needDevice(req);
    const { stage, message, browser } = z
      .object({ stage: z.string().max(40), message: z.string().max(500), browser: z.string().max(300).optional() })
      .parse(req.body);
    await Device.updateOne({ _id: req.deviceId }, { $set: { mlsError: { stage, message, browser, at: new Date() } } });
    res.json({ ok: true });
  })
);

/** Public keys of devices (to check the identities inside encryption groups). */
router.get(
  '/keys',
  handle(async (req, res) => {
    const ids = String(req.query.devices || '')
      .split(',')
      .filter((id) => mongoose.isValidObjectId(id))
      .slice(0, 200);
    const devices = await Device.find({ _id: { $in: ids }, mlsKey: { $exists: true } }, 'user mlsKey revokedAt').lean();
    res.json({ keys: devices.map((d) => ({ deviceId: String(d._id), userId: String(d.user), key: d.mlsKey, revoked: !!d.revokedAt })) });
  })
);

router.post(
  '/key-packages',
  handle(async (req, res) => {
    needDevice(req);
    const { packages } = z
      .object({
        packages: z
          .array(z.object({ id: z.string().regex(/^(lr-[a-f0-9]{28}|[a-f0-9]{32})$/), data: b64, lastResort: z.boolean().optional() }))
          .max(MAX_KEY_PACKAGES + 1),
      })
      .parse(req.body);
    // At most one last resort KeyPackage per device: a new one replaces it.
    const last = packages.find((p) => p.lastResort);
    if (last) {
      await KeyPackage.deleteMany({ device: req.deviceId, lastResort: true });
      await KeyPackage.create({ device: req.deviceId, user: req.userId, keyId: last.id, data: last.data, lastResort: true });
    }
    const oneTime = packages.filter((p) => !p.lastResort);
    const have = await KeyPackage.countDocuments({ device: req.deviceId, lastResort: { $ne: true } });
    const room = Math.max(0, MAX_KEY_PACKAGES - have);
    if (room && oneTime.length) await KeyPackage.insertMany(oneTime.slice(0, room).map((p) => ({ device: req.deviceId, user: req.userId, keyId: p.id, data: p.data })));
    // A device's first keys: others can add it now (e.g. to send it what it missed).
    if (!have && packages.length) announceRoster(req.userId).catch(() => {});
    res.json({ count: have + Math.min(room, oneTime.length) });
  })
);

router.get(
  '/key-packages/count',
  handle(async (req, res) => {
    needDevice(req);
    res.json({
      count: await KeyPackage.countDocuments({ device: req.deviceId, lastResort: { $ne: true } }),
      lastResort: !!(await KeyPackage.exists({ device: req.deviceId, lastResort: true })),
    });
  })
);

/** Takes one KeyPackage of each of these devices, to add them to a chat I'm in. */
router.post(
  '/key-packages/claim',
  handle(async (req, res) => {
    needDevice(req);
    const { conversationId, deviceIds } = z.object({ conversationId: z.string(), deviceIds: z.array(z.string()).min(1).max(200) }).parse(req.body);
    const conv = await memberConv(req, conversationId);
    const allowed = new Set((await rosterOf(conv)).devices.map((d) => d.deviceId));
    const packages = [];
    for (const deviceId of new Set(deviceIds)) {
      if (!allowed.has(deviceId)) continue;
      // A one-time KeyPackage, else (all used up) the device's last resort one, which stays.
      const kp =
        (await KeyPackage.findOneAndDelete({ device: deviceId, lastResort: { $ne: true } }, { sort: { createdAt: 1 } }).lean()) ||
        (await KeyPackage.findOne({ device: deviceId, lastResort: true }).lean());
      if (kp) packages.push({ deviceId, keyId: kp.keyId, data: kp.data });
    }
    res.json({ packages });
  })
);

// ---- The encrypted channel between my own devices (an MLS group of just my devices)

/** My own-devices channel (created on first use; one per account). */
router.post(
  '/self',
  handle(async (req, res) => {
    needDevice(req);
    const conv = await Conversation.findOneAndUpdate(
      { selfOf: req.userId },
      { $setOnInsert: { type: 'self', selfOf: req.userId, participants: [{ user: req.userId, role: 'admin' }] } },
      { upsert: true, new: true }
    ).catch(async (err) => {
      if (err.code === 11000) return Conversation.findOne({ selfOf: req.userId }); // created at the same moment elsewhere
      throw err;
    });
    res.json({ conversationId: String(conv._id) });
  })
);

/** Posts an encrypted message to my other devices. */
router.post(
  '/sync',
  handle(async (req, res) => {
    needDevice(req);
    const { ciphertext, epoch } = z.object({ ciphertext: z.string().min(16).max(700_000).regex(/^[A-Za-z0-9+/=]+$/), epoch: z.number().int().min(0) }).parse(req.body);
    const msg = await SyncMessage.create({ user: req.userId, device: req.deviceId, epoch, ciphertext });
    emitToUser(req.userId, EVENTS.MLS_SYNC, { id: String(msg._id) });
    res.status(201).json({ id: String(msg._id) });
  })
);

/** My own-devices messages after `after` (an id), oldest first. */
router.get(
  '/sync',
  handle(async (req, res) => {
    needDevice(req);
    const after = mongoose.isValidObjectId(req.query.after) ? { _id: { $gt: req.query.after } } : {};
    const list = await SyncMessage.find({ user: req.userId, ...after }).sort({ _id: 1 }).limit(50).lean();
    res.json({ messages: list.map((m) => ({ id: String(m._id), device: String(m.device), epoch: m.epoch, ciphertext: m.ciphertext, at: m.createdAt })) });
  })
);

/** A chat's encryption status, its devices, and the public info for joining. */
router.get(
  '/:id',
  handle(async (req, res) => {
    const conv = await memberConv(req);
    const roster = await rosterOf(conv);
    res.json({ enabled: !!conv.mls?.enabled, epoch: conv.mls?.epoch ?? 0, groupInfo: conv.mls?.groupInfo || null, ...roster });
  })
);

/**
 * Turns encryption on for a chat. The caller then creates the group and adds every device it
 * can; members without one yet get messages sent again once they have one (encryption is
 * required, so nobody waits for them).
 */
router.post(
  '/:id/start',
  handle(async (req, res) => {
    needDevice(req);
    const conv = await memberConv(req);
    if (conv.mls?.enabled) throw new HttpError(409, 'Encryption is already on');
    if (!(await Device.exists({ _id: req.deviceId, mlsKey: { $exists: true } }))) throw new HttpError(400, 'Encryption isn’t set up on this device yet');
    const started = await Conversation.updateOne(
      { _id: conv._id, 'mls.enabled': { $ne: true } },
      { $set: { mls: { enabled: true, epoch: 0, startedBy: req.deviceId } } }
    );
    if (!started.modifiedCount) throw new HttpError(409, 'Encryption is already on');
    if (conv.type !== 'self') await broadcastConversation(conv._id); // every member's app now shows the chat as encrypted
    res.json({ ok: true, epoch: 0 });
  })
);

/**
 * A key change. It must be made in the group's current epoch: exactly one commit per epoch is
 * accepted, and anyone else gets 409 with the current epoch (catch up, then try again).
 */
router.post(
  '/:id/commits',
  handle(async (req, res) => {
    needDevice(req);
    const { epoch, commit, groupInfo, welcomes } = z
      .object({
        epoch: z.number().int().min(0),
        commit: b64,
        groupInfo: b64,
        welcomes: z.array(z.object({ deviceId: z.string(), keyId: z.string(), data: b64 })).max(200).default([]),
      })
      .parse(req.body);
    const conv = await memberConv(req);
    if (!conv.mls?.enabled) throw new HttpError(400, 'Encryption is off in this chat');
    const moved = await Conversation.updateOne(
      { _id: conv._id, 'mls.epoch': epoch },
      { $set: { 'mls.epoch': epoch + 1, 'mls.groupInfo': groupInfo } }
    );
    if (!moved.modifiedCount) {
      const now = await Conversation.findById(conv._id, 'mls.epoch').lean();
      return res.status(409).json({ message: 'The group changed: catch up and try again', epoch: now.mls.epoch });
    }
    await MlsCommit.create({ conversation: conv._id, epoch, device: req.deviceId, data: commit });
    if (welcomes.length) {
      await MlsWelcome.insertMany(welcomes.map((w) => ({ device: w.deviceId, conversation: conv._id, epoch: epoch + 1, keyId: w.keyId, data: w.data })));
      emitToDevices(welcomes.map((w) => w.deviceId), EVENTS.MLS_WELCOME, { conversationId: String(conv._id) });
    }
    emitToConversations([conv._id], EVENTS.MLS_COMMIT, { conversationId: String(conv._id), epoch: epoch + 1, device: req.deviceId });
    res.status(201).json({ epoch: epoch + 1 });
  })
);

const RESEND_WITHIN_MS = 30 * 24 * 3600 * 1000;

/**
 * A message encrypted when some member had no device (signed out everywhere): the device that
 * sent it encrypts it again, now that they have one. Only that device, for its own message.
 */
router.post(
  '/:id/messages/:mid/resend',
  handle(async (req, res) => {
    needDevice(req);
    const { ciphertext, epoch } = z.object({ ciphertext: b64, epoch: z.number().int().min(0) }).parse(req.body);
    const conv = await memberConv(req);
    const message = mongoose.isValidObjectId(req.params.mid) ? await Message.findOne({ _id: req.params.mid, conversation: conv._id }) : null;
    if (!message?.e2ee?.ciphertext || message.deletedForEveryone) throw new HttpError(404, 'Message not found');
    if (!sameId(message.sender, req.userId) || String(message.e2ee.device) !== String(req.deviceId)) {
      throw new HttpError(403, 'Only the device that sent this message can send it again');
    }
    if (Date.now() - message.createdAt > RESEND_WITHIN_MS) throw new HttpError(410, 'This message is too old to send again');
    const e2ee = { ciphertext, epoch, device: req.deviceId };
    await Message.updateOne({ _id: message._id }, { $set: { e2ee } });
    emitToConversations([conv._id], EVENTS.MESSAGE_UPDATED, { id: String(message._id), conversationId: String(conv._id), e2ee });
    res.json({ ok: true });
  })
);

/** Key changes from epoch `from` on, in order. */
router.get(
  '/:id/commits',
  handle(async (req, res) => {
    const conv = await memberConv(req);
    const from = Math.max(0, Number(req.query.from) || 0);
    const commits = await MlsCommit.find({ conversation: conv._id, epoch: { $gte: from } }).sort({ epoch: 1 }).limit(200).lean();
    res.json({ commits: commits.map((c) => ({ epoch: c.epoch, device: String(c.device), data: c.data })) });
  })
);

/** Welcomes waiting for this device (it was added to these chats). */
router.get(
  '/welcomes/mine',
  handle(async (req, res) => {
    needDevice(req);
    const list = await MlsWelcome.find({ device: req.deviceId }).sort({ createdAt: 1 }).lean();
    res.json({ welcomes: list.map((w) => ({ id: String(w._id), conversationId: String(w.conversation), epoch: w.epoch, keyId: w.keyId, data: w.data })) });
  })
);

router.delete(
  '/welcomes/:wid',
  handle(async (req, res) => {
    needDevice(req);
    if (mongoose.isValidObjectId(req.params.wid)) await MlsWelcome.deleteOne({ _id: req.params.wid, device: req.deviceId });
    res.json({ ok: true });
  })
);

export default router;
