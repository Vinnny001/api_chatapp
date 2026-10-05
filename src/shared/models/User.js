import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    // The registered name is private: only the user sees it. Others see the name they saved
    // the person under, else the username, else the phone number (see publicUser).
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Optional public handle (rules in people.js). Unset (not null) when missing, so the
    // sparse unique index ignores accounts without one.
    username: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    gender: { type: String, enum: ['Male', 'Female', 'Other'] },
    passwordHash: { type: String, required: true, select: false },
    // false until the email code is entered. Missing on accounts from before email
    // confirmation existed: those count as confirmed.
    emailVerified: { type: Boolean, default: undefined },
    // The current one-time code (confirm email / reset password), hashed.
    emailCode: {
      type: { _id: false, hash: String, purpose: String, expiresAt: Date, attempts: Number, sentAt: Date },
      default: undefined,
      select: false,
    },
    // Switched off by an admin: can't sign in or use the app.
    disabled: { type: Boolean, default: undefined },
    // People this user blocked (they can't message, call or see them).
    blocked: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: undefined },
    avatarUrl: { type: String, default: null },
    about: { type: String, default: 'Hey there! I am using ChatApp.', maxlength: 140 },
    lastSeen: { type: Date, default: null },
    settings: {
      showLastSeen: { type: Boolean, default: true },
      // Only matters with a username: without one, the phone number is how people see you.
      showPhone: { type: Boolean, default: false },
      showEmail: { type: Boolean, default: false },
    },
    // People this user saved in ChatApp (their own contact list, kept on every device).
    contacts: {
      type: [
        {
          _id: false,
          user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          name: { type: String, trim: true, maxlength: 60, default: '' },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: false,
    },
    // Phones signed in to this account, for push notifications (Firebase Cloud Messaging).
    devices: {
      type: [{ _id: false, token: String, platform: String, updatedAt: Date }],
      default: [],
      select: false,
    },
  },
  { timestamps: true }
);

userSchema.index({ name: 1 });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
