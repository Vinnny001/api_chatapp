import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, config, publicUser, signToken, usernameProblem, verifyAnyToken } from '#shared';
import { codeEmail, sendEmail } from '../email.js';
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

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or phone'),
  password: z.string().min(1, 'Enter your password'),
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

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
    res.json({ token: signToken(user._id), user: selfView(user) });
  })
);

const sixDigits = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

/** Confirm the email with the code we sent: the pending login becomes a full one. */
router.post(
  '/verify-email',
  authLimiter,
  requireAnyAuth,
  handle(async (req, res) => {
    const { code } = z.object({ code: sixDigits }).parse(req.body);
    const existing = await User.findById(req.userId);
    if (!existing) throw new HttpError(401, 'Account no longer exists');
    if (existing.emailVerified !== false) return res.json({ token: signToken(existing._id), user: selfView(existing) });
    await checkCode(req.userId, 'verify', code);
    const user = await User.findByIdAndUpdate(req.userId, { $set: { emailVerified: true } }, { new: true });
    res.json({ token: signToken(user._id), user: selfView(user) });
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
    const { email, code, password } = z
      .object({
        email: z.string().trim().toLowerCase().email('Enter a valid email'),
        code: sixDigits,
        password: z.string().min(6, 'Password must be at least 6 characters').max(128),
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
    res.json({ token: signToken(user._id), user: selfView(user) });
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
