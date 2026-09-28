import mongoose from 'mongoose';
import { ZodError } from 'zod';
import multer from 'multer';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps an async route so rejected promises reach the error handler. */
export const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(_req, _res, next) {
  next(new HttpError(404, 'Not found'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: err.issues[0]?.message || 'Invalid request',
      errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ message: 'Invalid id' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ message: err.message });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, ...(err.details && { errors: err.details }) });
  }
  console.error('[api] unhandled error:', err);
  res.status(500).json({ message: 'Server error' });
}
