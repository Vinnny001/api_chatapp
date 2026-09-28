import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '#shared';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, handle } from '../middleware/errors.js';

// Files go to Cloudinary when it is configured (production: survives restarts/redeploys),
// otherwise to local disk under /uploads (development).
const useCloudinary = Boolean(config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret);
if (useCloudinary) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true,
  });
} else {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

const MB = 1024 * 1024;
const INLINE_EXTENSIONS = new Set(
  '.png .jpg .jpeg .gif .webp .avif .heic .mp4 .webm .mov .m4v .ogg .oga .mp3 .m4a .aac .wav .opus'.split(' ')
);

const safeExtension = (name) => path.extname(name).toLowerCase().replace(/[^.\w]/g, '').slice(0, 10);
const randomName = () => `${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}`;

/** Cloudinary resource type: audio is handled as "video"; SVG and documents stay raw files. */
function resourceType(mime) {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'video';
  return 'raw';
}

// Cloudinary free plan: images and raw files up to 10 MB, video/audio up to 100 MB.
const TYPE_LIMITS = { image: 10 * MB, raw: 10 * MB, video: 100 * MB };

function uploadToCloudinary(file) {
  const type = resourceType(file.mimetype);
  const limit = Math.min(TYPE_LIMITS[type], config.maxUploadMb * MB);
  if (file.size > limit) {
    throw new HttpError(413, `This file is too large (max ${Math.round(limit / MB)} MB for this type)`);
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: config.cloudinary.folder,
        resource_type: type,
        // Raw files keep their extension so downloads open with the right app.
        public_id: randomName() + (type === 'raw' ? safeExtension(file.originalname) : ''),
        overwrite: false,
      },
      (err, result) => {
        if (err) reject(new HttpError(502, `Upload failed: ${err.message}`));
        else resolve(result.secure_url);
      }
    );
    stream.end(file.buffer);
  });
}

function saveToDisk(file) {
  const name = randomName() + safeExtension(file.originalname);
  fs.writeFileSync(path.join(config.uploadDir, name), file.buffer);
  return `/uploads/${name}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * MB, files: 1 },
});

const router = Router();

router.post(
  '/',
  requireAuth,
  upload.single('file'),
  handle(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded');
    const url = useCloudinary ? await uploadToCloudinary(req.file) : saveToDisk(req.file);
    res.status(201).json({
      url,
      name: req.file.originalname.slice(0, 200),
      size: req.file.size,
      mime: req.file.mimetype,
    });
  })
);

// Local-disk mode only. Media renders inline; anything else (html, svg, pdf, ...) is forced
// to download so an uploaded file can never run script on this origin.
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
