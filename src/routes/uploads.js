import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '#shared';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, handle } from '../middleware/errors.js';
import { StoredFile } from '../models/StoredFile.js';

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
// Bigger documents / APKs are stored in parts (see uploadInParts).
const TYPE_LIMITS = { image: 10 * MB, raw: 10 * MB, video: 100 * MB };
const PART_SIZE = 9.5 * MB;

export const APK_MIME = 'application/vnd.android.package-archive';
// Cloudinary won't store these extensions, so they always go through uploadInParts.
const STORED_IN_PARTS = new Set(['.apk']);

function sendToCloudinary(buffer, { type, publicId }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: config.cloudinary.folder, resource_type: type, public_id: publicId, overwrite: false },
      (err, result) => {
        if (err) reject(new HttpError(502, `Upload failed: ${err.message}`));
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

/** A large raw file (e.g. an APK): parts on Cloudinary, one download URL on this API. */
async function uploadInParts(file, userId) {
  const base = randomName();
  const parts = [];
  for (let offset = 0, i = 0; offset < file.size; offset += PART_SIZE, i++) {
    parts.push(await sendToCloudinary(file.buffer.subarray(offset, offset + PART_SIZE), { type: 'raw', publicId: `${base}.part${i}` }));
  }
  const doc = await StoredFile.create({ name: file.originalname, mime: file.mimetype, size: file.size, parts, uploadedBy: userId });
  const safeName = file.originalname.replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
  return `/files/${doc._id}/${safeName}`;
}

function uploadToCloudinary(file, userId) {
  const type = resourceType(file.mimetype);
  const max = config.maxUploadMb * MB;
  // Too big for one raw upload, or a type Cloudinary refuses to store (.apk): parts.
  const blocked = STORED_IN_PARTS.has(safeExtension(file.originalname));
  if (type === 'raw' && (blocked || file.size > TYPE_LIMITS.raw) && file.size <= max) return uploadInParts(file, userId);
  const limit = Math.min(TYPE_LIMITS[type], max);
  if (file.size > limit) {
    throw new HttpError(413, `This file is too large (max ${Math.round(limit / MB)} MB for this type)`);
  }
  // Raw files keep their extension so downloads open with the right app.
  return sendToCloudinary(file.buffer, { type, publicId: randomName() + (type === 'raw' ? safeExtension(file.originalname) : '') });
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
    // Android apps: the right type, so tapping the file opens the installer.
    if (safeExtension(req.file.originalname) === '.apk') req.file.mimetype = APK_MIME;
    const url = useCloudinary ? await uploadToCloudinary(req.file, req.userId) : saveToDisk(req.file);
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

/** GET /files/:id/:name: a file stored in parts, downloaded as one (public like Cloudinary URLs). */
export const serveStoredFile = handle(async (req, res) => {
  if (!/^[a-f0-9]{24}$/.test(req.params.id)) throw new HttpError(404, 'Not found');
  const file = await StoredFile.findById(req.params.id).lean();
  if (!file) throw new HttpError(404, 'Not found');
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  for (const url of file.parts) {
    const part = await fetch(url);
    if (!part.ok || !part.body) {
      res.destroy(new Error(`part unavailable: HTTP ${part.status}`));
      return;
    }
    for await (const chunk of part.body) {
      if (!res.write(chunk)) await once(res, 'drain');
    }
  }
  res.end();
});

export default router;
