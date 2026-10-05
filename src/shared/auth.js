import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * A login token. `pending` tokens belong to accounts whose email isn't confirmed yet: they
 * only work for the email-code routes, never for chatting (verifyToken rejects them).
 */
export function signToken(userId, { pending = false } = {}) {
  return jwt.sign({ sub: String(userId), ...(pending && { pending: true }) }, config.jwtSecret, {
    expiresIn: pending ? '2d' : config.jwtExpiresIn,
  });
}

/** Returns the user id stored in a full token, or null (invalid, expired or still pending). */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.pending) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Like verifyToken, but also accepts pending tokens (email confirmation routes only). */
export function verifyAnyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
