import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Conversation, Device, EVENTS, USER_FIELDS, User, publicUser, sameId } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToUser } from '../realtime.js';
import { Status } from '../models/Status.js';

// Status updates (as on WhatsApp): text, photos and videos that disappear after 24 hours,
// shown to the people the author's status privacy allows. End-to-end encrypted (see
// models/Status.js): the server stores ciphertext, who may see it, and who viewed it.

const DAY_MS = 24 * 3600 * 1000;
const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const b64 = z.string().min(16).max(400_000).regex(/^[A-Za-z0-9+/=_-]+$/);
const router = Router();

/** My contacts: people I saved in ChatApp and people I chat with one to one (not blocked either way). */
async function contactsOf(userId) {
  const me = await User.findById(userId, '+contacts blocked').lean();
  const direct = await Conversation.find({ type: 'direct', 'participants.user': userId }, 'participants.user').lean();
  const ids = new Set([...(me?.contacts || []).map((c) => String(c.user)), ...direct.flatMap((c) => c.participants.map((p) => String(p.user)))]);
  ids.delete(String(userId));
  const iBlocked = new Set((me?.blocked || []).map(String));
  const people = await User.find({ _id: { $in: [...ids] }, disabled: { $ne: true } }, 'blocked').lean();
  return people.filter((u) => !iBlocked.has(String(u._id)) && !(u.blocked || []).some((b) => sameId(b, userId))).map((u) => String(u._id));
}

const privacyOf = (u) => ({
  mode: u?.statusPrivacy?.mode || 'contacts',
  except: (u?.statusPrivacy?.except || []).map(String),
  only: (u?.statusPrivacy?.only || []).map(String),
});

/** Who may see my status updates now. */
async function audienceOf(userId) {
  const p = privacyOf(await User.findById(userId, 'statusPrivacy').lean());
  const contacts = await contactsOf(userId);
  if (p.mode === 'only') return contacts.filter((id) => p.only.includes(id));
  if (p.mode === 'except') return contacts.filter((id) => !p.except.includes(id));
  return contacts;
}

const notExpired = () => ({ expiresAt: { $gt: new Date() } });
const hidesLastSeen = async (userId) => (await User.findById(userId, 'settings').lean())?.settings?.showLastSeen === false;

// ---- Privacy

router.get(
  '/settings',
  handle(async (req, res) => {
    const me = await User.findById(req.userId, 'statusPrivacy settings').lean();
    const contacts = await User.find({ _id: { $in: await contactsOf(req.userId) } }, USER_FIELDS).lean();
    const hideLastSeen = me?.settings?.showLastSeen === false;
    res.json({ ...privacyOf(me), contacts: contacts.map((u) => publicUser(u, { hideLastSeen })) });
  })
);

router.put(
  '/settings',
  handle(async (req, res) => {
    const data = z
      .object({ mode: z.enum(['contacts', 'except', 'only']), except: z.array(objectId).max(2000).default([]), only: z.array(objectId).max(2000).default([]) })
      .parse(req.body);
    await User.updateOne({ _id: req.userId }, { $set: { statusPrivacy: data } });
    res.json({ ...data, audience: (await audienceOf(req.userId)).length });
  })
);

// ---- Keys: each device's status key (published by the device, signed with its identity)

router.put(
  '/key',
  handle(async (req, res) => {
    if (!req.deviceId) throw new HttpError(400, 'Update ChatApp to use status');
    const { pub, sig } = z.object({ pub: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), sig: b64 }).parse(req.body);
    await Device.updateOne({ _id: req.deviceId }, { $set: { statusKey: { pub, sig } } });
    res.json({ ok: true });
  })
);

/** The devices to seal my next update for: those of the people who may see it, and my own. */
router.get(
  '/keys',
  handle(async (req, res) => {
    const audience = await audienceOf(req.userId);
    const devices = await Device.find(
      { user: { $in: [...audience, req.userId] }, revokedAt: null, mlsKey: { $exists: true }, 'statusKey.pub': { $exists: true } },
      'user statusKey'
    ).lean();
    res.json({
      audience: audience.length,
      devices: devices.map((d) => ({ userId: String(d.user), deviceId: String(d._id), pub: d.statusKey.pub, sig: d.statusKey.sig })),
    });
  })
);

// ---- Updates

router.post(
  '/',
  handle(async (req, res) => {
    if (!req.deviceId) throw new HttpError(400, 'Update ChatApp to post a status');
    const { content, envelopes } = z
      .object({ content: b64, envelopes: z.array(z.object({ device: objectId, data: b64.max(2000) })).min(1).max(5000) })
      .parse(req.body);
    // Envelopes only for devices of people allowed to see it (or my own).
    const audience = await audienceOf(req.userId);
    const allowed = new Set([...audience, req.userId]);
    const owners = await Device.find({ _id: { $in: envelopes.map((e) => e.device) } }, 'user').lean();
    const ownerOf = new Map(owners.map((d) => [String(d._id), String(d.user)]));
    const kept = envelopes.filter((e) => allowed.has(ownerOf.get(e.device)));
    const status = await Status.create({ user: req.userId, content, envelopes: kept, audience, expiresAt: new Date(Date.now() + DAY_MS) });
    for (const id of allowed) emitToUser(id, EVENTS.STATUS_NEW, { userId: req.userId, id: String(status._id) });
    res.status(201).json({ id: String(status._id), createdAt: status.createdAt, expiresAt: status.expiresAt, audience: audience.length });
  })
);

/** For this device: an update with only the envelope sealed to it. */
const forDevice = (s, deviceId) => ({
  id: String(s._id),
  user: String(s.user),
  content: s.content,
  envelope: (s.envelopes || []).find((e) => String(e.device) === String(deviceId))?.data || null,
  createdAt: s.createdAt,
  expiresAt: s.expiresAt,
});

/** My updates (with who viewed them), and those of people who let me see theirs. */
router.get(
  '/feed',
  handle(async (req, res) => {
    const me = await User.findById(req.userId, 'blocked statusMuted').lean();
    const hideLastSeen = await hidesLastSeen(req.userId);
    const mine = await Status.find({ user: req.userId, ...notExpired() }).sort({ createdAt: 1 }).lean();
    const viewerIds = [...new Set(mine.flatMap((s) => s.views.map((v) => String(v.user))))];
    const viewers = new Map((await User.find({ _id: { $in: viewerIds } }, USER_FIELDS).lean()).map((u) => [String(u._id), u]));

    const theirs = await Status.find({ audience: req.userId, ...notExpired() }).sort({ createdAt: 1 }).lean();
    const iBlocked = new Set((me?.blocked || []).map(String));
    const owners = await User.find({ _id: { $in: [...new Set(theirs.map((s) => String(s.user)))] } }, USER_FIELDS).lean();
    const ownerById = new Map(owners.filter((u) => !iBlocked.has(String(u._id)) && !(u.blocked || []).some((b) => sameId(b, req.userId))).map((u) => [String(u._id), u]));
    const muted = new Set((me?.statusMuted || []).map(String));
    const byOwner = new Map();
    for (const s of theirs) {
      const owner = String(s.user);
      if (!ownerById.has(owner)) continue;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push({ ...forDevice(s, req.deviceId), viewed: s.views.some((v) => sameId(v.user, req.userId)) });
    }
    res.json({
      mine: mine.map((s) => ({
        ...forDevice(s, req.deviceId),
        audience: s.audience.length,
        viewers: s.views.filter((v) => viewers.has(String(v.user))).map((v) => ({ user: publicUser(viewers.get(String(v.user)), { hideLastSeen }), at: v.at })),
      })),
      others: [...byOwner].map(([owner, statuses]) => ({ user: publicUser(ownerById.get(owner), { hideLastSeen }), muted: muted.has(owner), statuses })),
    });
  })
);

/** I saw it (its author is told). */
router.post(
  '/:id/view',
  handle(async (req, res) => {
    const status = mongoose.isValidObjectId(req.params.id) ? await Status.findOne({ _id: req.params.id, ...notExpired() }, 'user audience') : null;
    if (!status || !(sameId(status.user, req.userId) || status.audience.some((u) => sameId(u, req.userId)))) throw new HttpError(404, 'Status not found');
    if (sameId(status.user, req.userId)) return res.json({ ok: true }); // my own: not a view
    const at = new Date();
    const added = await Status.updateOne({ _id: status._id, 'views.user': { $ne: req.userId } }, { $push: { views: { user: req.userId, at } } });
    if (added.modifiedCount) emitToUser(status.user, EVENTS.STATUS_VIEW, { id: String(status._id), user: req.userId, at });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  handle(async (req, res) => {
    const status = mongoose.isValidObjectId(req.params.id) ? await Status.findOneAndDelete({ _id: req.params.id, user: req.userId }, { projection: 'audience' }).lean() : null;
    if (!status) throw new HttpError(404, 'Status not found');
    for (const id of [...status.audience.map(String), req.userId]) emitToUser(id, EVENTS.STATUS_REMOVED, { userId: req.userId, id: String(status._id) });
    res.json({ ok: true });
  })
);

/** Mute (or unmute) someone's status updates. */
router.put(
  '/mute/:userId',
  handle(async (req, res) => {
    const { muted } = z.object({ muted: z.boolean() }).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.userId)) throw new HttpError(404, 'User not found');
    await User.updateOne({ _id: req.userId }, muted ? { $addToSet: { statusMuted: req.params.userId } } : { $pull: { statusMuted: req.params.userId } });
    res.json({ muted });
  })
);

export default router;
