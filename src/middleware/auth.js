import { authenticate } from '#shared';
import { HttpError } from './errors.js';

/**
 * A valid (confirmed-email) login of an account that isn't disabled, from a device that
 * hasn't been signed out. Sets req.userId and req.deviceId (null for pre-device tokens).
 */
export async function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    const session = token && (await authenticate(token));
    if (!session) return next(new HttpError(401, 'Not signed in'));
    req.userId = session.userId;
    req.deviceId = session.deviceId;
    req.historyFrom = session.historyFrom; // set on a device that chose not to sync
    next();
  } catch (err) {
    next(err);
  }
}
