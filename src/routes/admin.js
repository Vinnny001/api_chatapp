import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { v2 as cloudinary } from 'cloudinary';
import { Conversation, Message, User, config } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { disconnectUser } from '../realtime.js';
import { Report } from '../models/Report.js';
import { isAdminEmail } from '../admin.js';

// The admin page: numbers, accounts and reports. It shows who uses the app and what was
// reported, never anyone's private chats (only the messages attached to a report).

const DAY = 24 * 3600 * 1000;
const router = Router();

/** Only accounts listed in ADMIN_EMAILS. */
router.use(
  handle(async (req, _res, next) => {
    const me = await User.findById(req.userId, 'email').lean();
    if (!isAdminEmail(me?.email)) throw new HttpError(403, 'Admins only');
    next();
  })
);

const dayKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };

/** Count per day for the last `days` days (oldest first, zero-filled). */
async function perDay(model, match, days) {
  const since = new Date(Date.now() - (days - 1) * DAY);
  since.setUTCHours(0, 0, 0, 0);
  const rows = await model.aggregate([{ $match: { ...match, createdAt: { $gte: since } } }, { $group: { _id: dayKey, n: { $sum: 1 } } }]);
  const byDay = new Map(rows.map((r) => [r._id, r.n]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
    return { day: d, count: byDay.get(d) || 0 };
  });
}

async function storageUsage() {
  if (!config.cloudinary.cloudName) return null;
  try {
    const u = await cloudinary.api.usage();
    return {
      plan: u.plan,
      storageMb: Math.round((u.storage?.usage || 0) / 1048576),
      bandwidthMb: Math.round((u.bandwidth?.usage || 0) / 1048576),
      creditsUsedPercent: u.credits?.used_percent ?? null,
    };
  } catch {
    return null;
  }
}

router.get(
  '/stats',
  handle(async (_req, res) => {
    const now = Date.now();
    const today = new Date(now - DAY);
    const week = new Date(now - 7 * DAY);
    const notSystem = { type: { $nin: ['system', 'call'] } };
    const [
      users,
      newToday,
      newWeek,
      activeToday,
      activeWeek,
      unverified,
      disabled,
      groups,
      direct,
      messagesToday,
      messagesWeek,
      openReports,
      signups,
      messages,
      calls,
      storage,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ createdAt: { $gte: week } }),
      User.countDocuments({ lastSeen: { $gte: today } }),
      User.countDocuments({ lastSeen: { $gte: week } }),
      User.countDocuments({ emailVerified: false }),
      User.countDocuments({ disabled: true }),
      Conversation.countDocuments({ type: 'group' }),
      Conversation.countDocuments({ type: 'direct' }),
      Message.countDocuments({ ...notSystem, createdAt: { $gte: today } }),
      Message.countDocuments({ ...notSystem, createdAt: { $gte: week } }),
      Report.countDocuments({ status: 'open' }),
      perDay(User, {}, 14),
      perDay(Message, notSystem, 14),
      perDay(Message, { type: 'call' }, 14),
      storageUsage(),
    ]);
    res.json({
      users: { total: users, newToday, newWeek, activeToday, activeWeek, unverified, disabled },
      chats: { groups, direct },
      messages: { today: messagesToday, week: messagesWeek },
      reports: { open: openReports },
      series: { signups, messages, calls },
      storage,
    });
  })
);

const userRow = (u, counts) => ({
  id: String(u._id),
  name: u.name,
  username: u.username || null,
  email: u.email,
  phone: u.phone,
  createdAt: u.createdAt,
  lastSeen: u.lastSeen,
  emailVerified: u.emailVerified !== false,
  disabled: !!u.disabled,
  admin: isAdminEmail(u.email),
  messages: counts.get(String(u._id)) || 0,
});

/** Accounts, newest first: search by name, username, email or phone; filter. */
router.get(
  '/users',
  handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { username: rx }, { email: rx }, { phone: rx }];
    }
    if (req.query.filter === 'disabled') filter.disabled = true;
    if (req.query.filter === 'unverified') filter.emailVerified = false;
    const page = Math.max(0, Number(req.query.page) || 0);
    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter, 'name username email phone createdAt lastSeen emailVerified disabled').sort({ createdAt: -1 }).skip(page * 50).limit(50).lean(),
    ]);
    const ids = users.map((u) => u._id);
    const counts = new Map(
      (await Message.aggregate([{ $match: { sender: { $in: ids } } }, { $group: { _id: '$sender', n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n])
    );
    res.json({ total, page, users: users.map((u) => userRow(u, counts)) });
  })
);

/** Disable (or re-enable) an account: signed out everywhere at once; can't sign in. */
router.post(
  '/users/:id/disable',
  handle(async (req, res) => {
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, 'Invalid id');
    const user = await User.findById(req.params.id, 'email');
    if (!user) throw new HttpError(404, 'User not found');
    if (isAdminEmail(user.email)) throw new HttpError(400, 'Admin accounts can not be disabled here');
    await User.updateOne({ _id: user._id }, disabled ? { $set: { disabled: true } } : { $unset: { disabled: 1 } });
    if (disabled) disconnectUser(user._id);
    res.json({ disabled });
  })
);

const personOut = (u) => (u ? { id: String(u._id), name: u.name, username: u.username || null, email: u.email, phone: u.phone, disabled: !!u.disabled } : null);

router.get(
  '/reports',
  handle(async (req, res) => {
    const status = ['open', 'dismissed', 'actioned'].includes(req.query.status) ? req.query.status : 'open';
    const reports = await Report.find({ status })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('reporter', 'name username email phone disabled')
      .populate('reported', 'name username email phone disabled')
      .lean();
    const timesReported = new Map(
      (await Report.aggregate([{ $group: { _id: '$reported', n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n])
    );
    res.json({
      reports: reports.map((r) => ({
        id: String(r._id),
        reason: r.reason,
        details: r.details || '',
        status: r.status,
        createdAt: r.createdAt,
        reporter: personOut(r.reporter),
        reported: personOut(r.reported),
        timesReported: timesReported.get(String(r.reported?._id)) || 1,
        messages: r.messages || [],
      })),
    });
  })
);

/** Close a report: dismissed (nothing wrong) or actioned (optionally disabling the account). */
router.patch(
  '/reports/:id',
  handle(async (req, res) => {
    const { status, disableUser } = z
      .object({ status: z.enum(['open', 'dismissed', 'actioned']), disableUser: z.boolean().default(false) })
      .parse(req.body);
    const report = await Report.findByIdAndUpdate(req.params.id, { $set: { status, reviewedBy: req.userId, reviewedAt: new Date() } }, { new: true });
    if (!report) throw new HttpError(404, 'Report not found');
    if (disableUser) {
      const user = await User.findById(report.reported, 'email');
      if (user && !isAdminEmail(user.email)) {
        await User.updateOne({ _id: user._id }, { $set: { disabled: true } });
        disconnectUser(user._id);
      }
    }
    res.json({ ok: true });
  })
);

const csv = (v) => {
  const s = v == null ? '' : String(v instanceof Date ? v.toISOString() : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** All accounts as a spreadsheet (CSV). */
router.get(
  '/export/users.csv',
  handle(async (_req, res) => {
    const users = await User.find({}, 'name username email phone createdAt lastSeen emailVerified disabled').sort({ createdAt: 1 }).lean();
    const lines = [['Name', 'Username', 'Email', 'Phone', 'Joined', 'Last seen', 'Email confirmed', 'Disabled'].join(',')];
    for (const u of users) {
      lines.push([u.name, u.username, u.email, u.phone, u.createdAt, u.lastSeen, u.emailVerified !== false ? 'yes' : 'no', u.disabled ? 'yes' : 'no'].map(csv).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chatapp-users-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n')); // BOM so Excel reads names with accents correctly
  })
);

export default router;
