import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsOriginOption } from '#shared';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';
import uploadRoutes, { serveUploads } from './routes/uploads.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Images/audio are loaded cross-origin by the web and Capacitor apps.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: corsOriginOption() }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'api' }));
  app.use('/uploads', serveUploads);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', requireAuth, userRoutes);
  app.use('/api/conversations', requireAuth, conversationRoutes);
  app.use('/api/messages', requireAuth, messageRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
