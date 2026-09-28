import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, publicUser, signToken } from '#shared';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, handle } from '../middleware/errors.js';

export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+?[0-9]{7,15}$/, 'Enter a valid phone number'));

const signupSchema = z.object({
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

router.post(
  '/signup',
  authLimiter,
  handle(async (req, res) => {
    const data = signupSchema.parse(req.body);
    const existing = await User.findOne({ $or: [{ email: data.email }, { phone: data.phone }] }).lean();
    if (existing) throw new HttpError(409, 'Email or phone number already in use');

    const user = await User.create({
      name: data.name,
      email: data.email,
      phone: data.phone,
      gender: data.gender,
      passwordHash: await bcrypt.hash(data.password, 10),
    });
    res.status(201).json({ token: signToken(user._id), user: publicUser(user, { self: true }) });
  })
);

router.post(
  '/login',
  authLimiter,
  handle(async (req, res) => {
    const { identifier, password } = loginSchema.parse(req.body);
    const phone = identifier.replace(/[\s()-]/g, '');
    const user = await User.findOne({ $or: [{ email: identifier.toLowerCase() }, { phone }] }).select(
      '+passwordHash'
    );
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(400, 'Invalid credentials');
    }
    res.json({ token: signToken(user._id), user: publicUser(user, { self: true }) });
  })
);

router.get(
  '/me',
  requireAuth,
  handle(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(401, 'Account no longer exists');
    res.json({ user: publicUser(user, { self: true }) });
  })
);

export default router;
