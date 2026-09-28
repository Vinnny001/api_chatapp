import { verifyToken } from '#shared';
import { HttpError } from './errors.js';

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && verifyToken(token);
  if (!userId) return next(new HttpError(401, 'Not signed in'));
  req.userId = userId;
  next();
}
