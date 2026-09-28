import jwt from 'jsonwebtoken';
import { config } from './config.js';

export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/** Returns the user id stored in the token, or null when the token is invalid/expired. */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
