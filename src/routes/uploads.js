import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import multer from 'multer';
import { config } from '#shared';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, handle } from '../middleware/errors.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const INLINE_EXTENSIONS = new Set(
  '.png .jpg .jpeg .gif .webp .avif .heic .mp4 .webm .mov .m4v .ogg .oga .mp3 .m4a .aac .wav .opus'.split(' ')
);

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '').slice(0, 10);
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

const router = Router();

router.post(
  '/',
  requireAuth,
  upload.single('file'),
  handle(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded');
    res.status(201).json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname.slice(0, 200),
      size: req.file.size,
      mime: req.file.mimetype,
    });
  })
);

// Media renders inline; anything else (html, svg, pdf, ...) is forced to download so an
// uploaded file can never run script on this origin.
export const serveUploads = express.static(config.uploadDir, {
  maxAge: '30d',
  immutable: true,
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!INLINE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
});

export default router;
