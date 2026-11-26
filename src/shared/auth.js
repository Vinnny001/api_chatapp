import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * A login token. `pending` tokens belong to accounts whose email isn't confirmed yet: they
 * only work for the email-code routes, never for chatting (verifyToken rejects them).
 */
export function signToken(userId, { pending = false, deviceId } = {}) {
  return jwt.sign({ sub: String(userId), ...(pending && { pending: true }), ...(deviceId && { did: String(deviceId) }) }, config.jwtSecret, {
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

/**
 * The payload of a full (not pending) login token, or null. `did` is the device it was
 * issued to (absent on tokens from before devices existed).
 */
export function readToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.pending || typeof payload.sub !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Why a token doesn't work by itself: 'expired' (too old) or 'invalid'. (Null when it does.)
 */
export function tokenProblem(token) {
  try {
    jwt.verify(token, config.jwtSecret);
    return null;
  } catch (err) {
    return err?.name === 'TokenExpiredError' ? 'expired' : 'invalid';
  }
}

/** A device token's payload even if it has expired (resuming a device), or null. */
export function readTokenIgnoringExpiry(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { ignoreExpiration: true });
    return payload.pending || typeof payload.sub !== 'string' || !payload.did ? null : payload;
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
