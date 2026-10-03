import mongoose from 'mongoose';

// A file bigger than Cloudinary allows for one non-media upload (10 MB on the free plan),
// e.g. an APK: stored on Cloudinary in parts and served back as one download by /files/:id.
const storedFileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    mime: { type: String, default: 'application/octet-stream' },
    size: { type: Number, required: true },
    parts: { type: [String], required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const StoredFile = mongoose.models.StoredFile || mongoose.model('StoredFile', storedFileSchema);
