import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  EVENTS,
  User,
  activeDevices,
  config,
  pushLoginRequest,
  pushLoginRequestDone,
  signToken,
  usernameProblem,
  verifyAnyToken,
} from '#shared';
import { codeEmail, sendEmail } from '../email.js';
import { LoginRequest } from '../models/LoginRequest.js';
import { clientIp, revokeDevices, revokeOtherDevices, startSession } from '../devices.js';
import { emitToUser } from '../realtime.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, handle } from '../middleware/errors.js';
import { selfView } from '../admin.js';
import { normalizePhone, phoneVariants } from '../phone.js';

// Stored in international form (+2547...) so every account's number has one spelling.
const phoneSchema = z
  .string()
  .transform((s, ctx) => {
    const phone = normalizePhone(s);
    if (!phone) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number' });
    return phone ?? z.NEVER;
  });

// Optional at sign-up; "@Alice" and " alice" are accepted as "alice".
export const usernameSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, '').toLowerCase())
  .superRefine((u, ctx) => {
    const problem = usernameProblem(u);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

const signupSchema = z.object({
  username: z.union([z.literal(''), usernameSchema]).optional(),
  name: z.string().trim().min(1, 'Name is required').max(60),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  phone: phoneSchema,
  gender: z.enum(['Male', 'Female', 'Other']).optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
});

// What the app says about the device it runs on ("ChatApp on Pixel 5", "Edge on Windows").
const deviceSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    platform: z.enum(['android', 'ios', 'web']).optional(),
  })
  .optional();

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or phone'),
  password: z.string().min(1, 'Enter your password'),
  device: deviceSchema,
});

function deviceOf(req, device) {
  return { name: device?.name || 'Unknown device', platform: device?.platform || 'web', ip: clientIp(req) };
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
// The new device checks every couple of seconds while it waits for approval.
const pollLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });

const router = Router();

// ---- One-time email codes (confirm the email address / reset the password)

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const hashCode = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}:${config.jwtSecret}`).digest('hex');

/** Emails a new 6-digit code. Returns false when one was sent less than a minute ago. */
async function sendCode(user, purpose, { force = false } = {}) {
  const current = (await User.findById(user._id, '+emailCode').lean())?.emailCode;
  if (!force && current?.purpose === purpose && Date.now() - current.sentAt < RESEND_AFTER_MS) return false;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const emailCode = { hash: hashCode(user._id, code), purpose, expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0, sentAt: new Date() };
  await User.updateOne({ _id: user._id }, { $set: { emailCode } });
  await sendEmail({ to: user.email, ...codeEmail({ code, purpose }) });
  return true;
}

/** Checks a code (5 tries per code); it can be used only once. */
async function checkCode(userId, purpose, code) {
  const user = await User.findById(userId, '+emailCode');
  const c = user?.emailCode;
  if (!c || c.purpose !== purpose || c.expiresAt < new Date()) throw new HttpError(400, 'That code has expired. Ask for a new one.');
  if (c.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
  if (c.hash !== hashCode(userId, String(code).trim())) {
    await User.updateOne({ _id: userId }, { $inc: { 'emailCode.attempts': 1 } });
    throw new HttpError(400, 'Wrong code. Check the email and try again.');
  }
  await User.updateOne({ _id: userId }, { $unset: { emailCode: 1 } });
  return user;
}

/** The answer for an account that still has to confirm its email: a pending login. */
function pendingSession(user, codeSent) {
  return { token: signToken(user._id, { pending: true }), user: selfView(user), verificationRequired: true, codeSent };
}

/** Accepts full and pending logins (the routes where you confirm your email). */
function requireAnyAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const userId = header.startsWith('Bearer ') && verifyAnyToken(header.slice(7));
  if (!userId) return next(new HttpError(401, 'Not signed in'));
  req.userId = userId;
  next();
}

async function trySendCode(user, purpose, options) {
  try {
    return await sendCode(user, purpose, options);
  } catch (err) {
    console.error('[api] code email failed:', err.message);
    return false;
  }
}

router.post(
  '/signup',
  authLimiter,
  handle(async (req, res) => {
    const data = signupSchema.parse(req.body);
    const existing = await User.findOne({
      $or: [{ email: data.email }, { phone: { $in: phoneVariants(data.phone) } }],
    }).lean();
    if (existing) throw new HttpError(409, 'Email or phone number already in use');
    if (data.username && (await User.exists({ username: data.username }))) {
      throw new HttpError(409, 'That username is taken');
    }

    const user = await User.create({
      name: data.name,
      ...(data.username && { username: data.username }),
      email: data.email,
      phone: data.phone,
      gender: data.gender,
      passwordHash: await bcrypt.hash(data.password, 10),
      emailVerified: false,
    });
    // The account works once the code we email is entered.
    res.status(201).json(pendingSession(user, await trySendCode(user, 'verify', { force: true })));
  })
);

/** Live check while typing a username (sign-up and settings). */
router.get(
  '/username/:username',
  handle(async (req, res) => {
    const parsed = usernameSchema.safeParse(req.params.username);
    if (!parsed.success) return res.json({ available: false, reason: parsed.error.issues[0].message });
    const taken = await User.exists({ username: parsed.data });
    res.json({ available: !taken, username: parsed.data, reason: taken ? 'That username is taken' : null });
  })
);

router.post(
  '/login',
  authLimiter,
  handle(async (req, res) => {
    const { identifier, password } = loginSchema.parse(req.body);
    // Accept the phone in any format ("07..", "+2547..") and older accounts' stored spelling.
    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { phone: { $in: phoneVariants(identifier) } }],
    }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(400, 'Invalid credentials');
    }
    if (user.disabled) throw new HttpError(403, 'This account has been disabled. Contact support.');
    if (user.emailVerified === false) return res.json(pendingSession(user, await trySendCode(user, 'verify')));

    const info = deviceOf(req, req.body.device);
    const approvers = await activeDevices(user._id);
    if (!approvers.length) {
      // No other device is signed in: the password is enough (and the email tells them).
      const { token } = await startSession(user, { ...info, approvedBy: 'first', req });
      return res.json({ token, user: selfView(user) });
    }
    // Another device is signed in: it has to approve this one (or a code sent to the email).
    const secret = crypto.randomBytes(24).toString('base64url');
    const request = await LoginRequest.create({
      user: user._id,
      secretHash: sha256(secret),
      ...info,
      match: crypto.randomInt(10, 100),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
    announceRequest(request);
    res.status(202).json({
      approvalRequired: true,
      request: { id: String(request._id), secret, match: request.match, expiresAt: request.expiresAt },
      devices: approvers.slice(0, 3).map((d) => d.name),
      email: maskEmail(user.email),
    });
  })
);

// ---- Sign-in approval for a new device

const REQUEST_TTL_MS = 10 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const maskEmail = (email) => email.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(b.length, 6)) + c);

/** Three numbers to pick from on the approving device: the right one plus two others, stable per request. */
export function matchChoices(request) {
  const seed = parseInt(sha256(`${request._id}:${request.secretHash}`).slice(0, 8), 16);
  const others = new Set();
  for (let i = 0; others.size < 2; i++) {
    const n = 10 + ((seed >>> (i % 24)) + i * 37) % 90;
    if (n !== request.match) others.add(n);
  }
  const all = [request.match, ...others];
  const shift = seed % 3;
  return [...all.slice(shift), ...all.slice(0, shift)];
}

export function requestView(r) {
  return {
    id: String(r._id),
    name: r.name,
    platform: r.platform,
    ip: r.ip,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    choices: matchChoices(r),
  };
}

/** Tells the account's signed-in devices (open apps live, phones by push). */
function announceRequest(request) {
  emitToUser(request.user, EVENTS.LOGIN_REQUEST, requestView(request));
  pushLoginRequest(request.user, { requestId: String(request._id), deviceName: request.name });
}

export function announceRequestDone(request) {
  emitToUser(request.user, EVENTS.LOGIN_REQUEST_DONE, { id: String(request._id), status: request.status });
  pushLoginRequestDone(request.user, String(request._id));
}

/** The new device's own request (it proves it with the secret only it was given). */
async function ownRequest(req) {
  const secret = req.get('x-request-secret') || req.body?.secret || '';
  const request = /^[a-f0-9]{24}$/.test(req.params.id) ? await LoginRequest.findById(req.params.id) : null;
  if (!request || request.secretHash !== sha256(secret)) throw new HttpError(404, 'Sign-in request not found');
  return request;
}

const expired = (r) => r.expiresAt < new Date();

/** Hands the approved request its login, once. */
async function collect(request, req, res) {
  const taken = await LoginRequest.findOneAndUpdate({ _id: request._id, status: 'approved' }, { $set: { status: 'used' } }, { new: true });
  if (!taken) throw new HttpError(410, 'This sign-in was already completed');
  const user = await User.findById(request.user);
  if (!user || user.disabled) throw new HttpError(403, 'This account has been disabled. Contact support.');
  const { token } = await startSession(user, {
    name: request.name,
    platform: request.platform,
    ip: request.ip,
    approvedBy: request.method,
    approver: request.approver,
    req,
  });
  res.json({ status: 'approved', token, user: selfView(user) });
}

/** The new device waits here: pending → approved (with the login) / denied / expired. */
router.get(
  '/login-requests/:id',
  pollLimiter,
  handle(async (req, res) => {
    const request = await ownRequest(req);
    if (request.status === 'approved') return collect(request, req, res);
    if (request.status === 'pending' && expired(request)) return res.json({ status: 'expired' });
    res.json({ status: request.status === 'used' ? 'expired' : request.status });
  })
);

/** Can't reach the other device: send a code to the account's email instead. */
router.post(
  '/login-requests/:id/email',
  authLimiter,
  handle(async (req, res) => {
    const request = await ownRequest(req);
    if (request.status !== 'pending' || expired(request)) throw new HttpError(410, 'This sign-in request has expired. Sign in again.');
    if (request.emailCode?.sentAt && Date.now() - request.emailCode.sentAt < 60_000) {
      throw new HttpError(429, 'Wait a minute before asking for another code');
    }
    const user = await User.findById(request.user, 'email');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    request.emailCode = { hash: sha256(`${request._id}:${code}`), attempts: 0, sentAt: new Date() };
    await request.save();
    await sendEmail({ to: user.email, ...codeEmail({ code, purpose: 'login' }) });
    res.json({ ok: true, email: maskEmail(user.email) });
  })
);

router.post(
  '/login-requests/:id/email/verify',
  authLimiter,
  handle(async (req, res) => {
    const { code } = z.object({ code: sixDigits }).parse(req.body);
    const request = await ownRequest(req);
    if (request.status !== 'pending' || expired(request)) throw new HttpError(410, 'This sign-in request has expired. Sign in again.');
    const c = request.emailCode;
    if (!c) throw new HttpError(400, 'Ask for a code first');
    if (c.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Sign in again.');
    if (c.hash !== sha256(`${request._id}:${code}`)) {
      await LoginRequest.updateOne({ _id: request._id }, { $inc: { 'emailCode.attempts': 1 } });
      throw new HttpError(400, 'Wrong code. Check the email and try again.');
    }
    const approved = await LoginRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending' },
      { $set: { status: 'approved', method: 'email' } },
      { new: true }
    );
    if (!approved) throw new HttpError(410, 'This sign-in request was already answered');
    announceRequestDone(approved);
    return collect(approved, req, res);
  })
);

/** The new device gave up waiting. */
router.delete(
  '/login-requests/:id',
  handle(async (req, res) => {
    const request = await ownRequest(req);
    if (request.status === 'pending') {
      request.status = 'denied';
      await request.save();
      announceRequestDone(request);
    }
    res.json({ ok: true });
  })
);

/** Sign out on this device. */
router.post(
  '/logout',
  requireAuth,
  handle(async (req, res) => {
    if (req.deviceId) await revokeDevices(req.userId, [req.deviceId]);
    res.json({ ok: true });
  })
);

const sixDigits = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

/** Confirm the email with the code we sent: the pending login becomes a full one. */
router.post(
  '/verify-email',
  authLimiter,
  requireAnyAuth,
  handle(async (req, res) => {
    const { code, device } = z.object({ code: sixDigits, device: deviceSchema }).parse(req.body);
    const existing = await User.findById(req.userId);
    if (!existing) throw new HttpError(401, 'Account no longer exists');
    if (existing.emailVerified !== false) throw new HttpError(400, 'Your email is already confirmed. Sign in again.');
    await checkCode(req.userId, 'verify', code);
    const user = await User.findByIdAndUpdate(req.userId, { $set: { emailVerified: true } }, { new: true });
    // The code proves the email: this device starts the account's first session.
    const { token } = await startSession(user, { ...deviceOf(req, device), approvedBy: 'signup', req, alert: false });
    res.json({ token, user: selfView(user) });
  })
);

router.post(
  '/resend-code',
  authLimiter,
  requireAnyAuth,
  handle(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(401, 'Account no longer exists');
    if (user.emailVerified !== false) throw new HttpError(400, 'Your email is already confirmed');
    if (!(await sendCode(user, 'verify'))) throw new HttpError(429, 'Wait a minute before asking for another code');
    res.json({ ok: true });
  })
);

/**
 * Forgot password: emails a reset code. The answer is the same whether or not the email has
 * an account, so this can not be used to find out who is registered.
 */
router.post(
  '/forgot',
  authLimiter,
  handle(async (req, res) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email') }).parse(req.body);
    const user = await User.findOne({ email });
    if (user && !user.disabled) await trySendCode(user, 'reset');
    res.json({ ok: true });
  })
);

/** Set a new password with the reset code; signs you in. */
router.post(
  '/reset',
  authLimiter,
  handle(async (req, res) => {
    const { email, code, password, device } = z
      .object({
        email: z.string().trim().toLowerCase().email('Enter a valid email'),
        code: sixDigits,
        password: z.string().min(6, 'Password must be at least 6 characters').max(128),
        device: deviceSchema,
      })
      .parse(req.body);
    const found = await User.findOne({ email });
    if (!found || found.disabled) throw new HttpError(400, 'Wrong code. Check the email and try again.');
    await checkCode(found._id, 'reset', code);
    // Entering a code sent to the email also proves the address is theirs.
    const user = await User.findByIdAndUpdate(
      found._id,
      { $set: { passwordHash: await bcrypt.hash(password, 10), emailVerified: true } },
      { new: true }
    );
    // A new password signs out every device (someone else may have had the old one).
    await revokeOtherDevices(user._id, null);
    const { token } = await startSession(user, { ...deviceOf(req, device), approvedBy: 'reset', req });
    res.json({ token, user: selfView(user) });
  })
);

router.get(
  '/me',
  requireAuth,
  handle(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(401, 'Account no longer exists');
    res.json({ user: selfView(user) });
  })
);

export default router;
