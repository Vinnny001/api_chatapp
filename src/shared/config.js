import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env') });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (copy .env.example to .env)`);
  return value;
}

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5050),
  mongoUri: required('MONGO_URI'),
  // Must match the realtime service's JWT_SECRET: it verifies the tokens issued here.
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  // Country code assumed for local numbers like "0712..." (254 = Kenya).
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '254').replace(/\D/g, ''),
  // Private endpoint of the realtime service used to push events to connected clients.
  realtimeInternalUrl: (process.env.REALTIME_INTERNAL_URL || 'http://localhost:5051').replace(/\/+$/, ''),
  internalSecret: required('INTERNAL_SECRET'),
  // Web app + Capacitor (capacitor://localhost on iOS, https://localhost on Android); "*" allows any.
  corsOrigins: list(
    process.env.CORS_ORIGINS ||
      'http://localhost:5173,http://127.0.0.1:5173,capacitor://localhost,https://localhost,http://localhost'
  ),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || 'uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 50),
  // When set, uploads are stored in Cloudinary instead of local disk.
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    folder: process.env.CLOUDINARY_FOLDER || 'chatapp',
  },
};

export function corsOriginOption() {
  return config.corsOrigins.includes('*') ? true : config.corsOrigins;
}
