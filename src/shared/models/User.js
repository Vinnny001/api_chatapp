import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    gender: { type: String, enum: ['Male', 'Female', 'Other'] },
    passwordHash: { type: String, required: true, select: false },
    avatarUrl: { type: String, default: null },
    about: { type: String, default: 'Hey there! I am using ChatApp.', maxlength: 140 },
    lastSeen: { type: Date, default: null },
    settings: {
      showLastSeen: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

userSchema.index({ name: 1 });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
