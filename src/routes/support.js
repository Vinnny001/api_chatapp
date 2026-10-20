import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { USER_FIELDS, User, publicUser } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { emitToUser } from '../realtime.js';
import { SupportTicket } from '../models/SupportTicket.js';
import { isAdminEmail } from '../admin.js';

// Help → Contact support: a user's requests and the support team's (admins') replies.

const router = Router();
const TOPICS = ['account', 'devices', 'messages', 'calls', 'groups', 'status', 'privacy', 'other'];
const text = z.string().trim().min(1, 'Write a message').max(4000);
const SUPPORT_UPDATE = 'support:update'; // { id } to the user and the admins

async function admins() {
  const emails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return emails.length ? User.find({ email: { $in: emails } }, '_id').lean() : [];
}
async function tell(ticket) {
  emitToUser(ticket.user, SUPPORT_UPDATE, { id: String(ticket._id) });
  for (const a of await admins()) emitToUser(a._id, SUPPORT_UPDATE, { id: String(ticket._id) });
}

const view = (t, { user } = {}) => ({
  id: String(t._id),
  topic: t.topic,
  subject: t.subject,
  state: t.state,
  messages: t.messages.map((m) => ({ from: m.from, text: m.text, at: m.at })),
  device: t.device || null,
  unread: !t.seenByUser,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  ...(user && { user }),
});

async function isAdmin(userId) {
  return isAdminEmail((await User.findById(userId, 'email').lean())?.email);
}

/** The ticket, if it's mine (or I'm support). */
async function ticketFor(req) {
  const t = mongoose.isValidObjectId(req.params.id) ? await SupportTicket.findById(req.params.id) : null;
  if (!t) throw new HttpError(404, 'Request not found');
  const admin = await isAdmin(req.userId);
  if (String(t.user) !== String(req.userId) && !admin) throw new HttpError(404, 'Request not found');
  return { t, admin };
}

// ---- The user's side

router.get(
  '/tickets',
  handle(async (req, res) => {
    const list = await SupportTicket.find({ user: req.userId }).sort({ updatedAt: -1 }).limit(100);
    res.json({ tickets: list.map((t) => view(t)) });
  })
);

router.post(
  '/tickets',
  handle(async (req, res) => {
    const data = z
      .object({ topic: z.enum(TOPICS).default('other'), subject: z.string().trim().min(3, 'Add a short subject').max(120), text, device: z.string().max(300).optional() })
      .parse(req.body);
    // (a few open requests at a time is plenty)
    if ((await SupportTicket.countDocuments({ user: req.userId, state: { $ne: 'closed' } })) >= 5) {
      throw new HttpError(429, 'You have 5 open requests. Wait for an answer, or close one.');
    }
    const t = await SupportTicket.create({ user: req.userId, topic: data.topic, subject: data.subject, device: data.device, messages: [{ from: 'user', author: req.userId, text: data.text }] });
    tell(t);
    res.status(201).json({ ticket: view(t) });
  })
);

router.get(
  '/tickets/:id',
  handle(async (req, res) => {
    const { t, admin } = await ticketFor(req);
    if (!admin && !t.seenByUser) {
      t.seenByUser = true;
      await t.save();
    }
    res.json({ ticket: view(t) });
  })
);

/** A reply: from the user (back to "open"), or from support (now "answered"). */
router.post(
  '/tickets/:id/messages',
  handle(async (req, res) => {
    const { text: body } = z.object({ text }).parse(req.body);
    const { t, admin } = await ticketFor(req);
    const asSupport = admin && String(t.user) !== String(req.userId);
    t.messages.push({ from: asSupport ? 'support' : 'user', author: req.userId, text: body });
    t.state = asSupport ? 'answered' : 'open';
    t.seenByUser = !asSupport;
    await t.save();
    tell(t);
    res.json({ ticket: view(t) });
  })
);

router.post(
  '/tickets/:id/close',
  handle(async (req, res) => {
    const { t } = await ticketFor(req);
    t.state = 'closed';
    await t.save();
    tell(t);
    res.json({ ticket: view(t) });
  })
);

// ---- Support (admins): every request

router.get(
  '/admin/tickets',
  handle(async (req, res) => {
    if (!(await isAdmin(req.userId))) throw new HttpError(403, 'Admins only');
    const state = z.enum(['open', 'answered', 'closed', 'all']).default('open').parse(req.query.state);
    const list = await SupportTicket.find(state === 'all' ? {} : { state }).sort({ updatedAt: -1 }).limit(200);
    const users = new Map((await User.find({ _id: { $in: list.map((t) => t.user) } }, `${USER_FIELDS} name`).lean()).map((u) => [String(u._id), u]));
    res.json({
      tickets: list.map((t) => {
        const u = users.get(String(t.user));
        // Support sees who wrote (name and email, to help them) – nothing of their chats.
        return view(t, { user: u ? { ...publicUser(u), name: u.name, email: u.email } : { id: String(t.user) } });
      }),
      openCount: await SupportTicket.countDocuments({ state: 'open' }),
    });
  })
);

export default router;
