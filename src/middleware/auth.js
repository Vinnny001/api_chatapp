import { User, verifyToken } from '#shared';
import { HttpError } from './errors.js';

/** A valid (confirmed-email) login of an account that isn't disabled. */
export async function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && verifyToken(token);
  if (!userId) return next(new HttpError(401, 'Not signed in'));
  try {
    if (!(await User.exists({ _id: userId, disabled: { $ne: true } }))) return next(new HttpError(401, 'Not signed in'));
  } catch (err) {
    return next(err);
  }
  req.userId = userId;
  next();
}
