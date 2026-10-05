import { publicUser } from '#shared';

// Admins: the accounts whose email is listed in ADMIN_EMAILS (comma-separated).
const adminEmails = () =>
  new Set(
    (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );

export const isAdminEmail = (email) => !!email && adminEmails().has(String(email).toLowerCase());

/** The signed-in user's own view of their account (adds isAdmin for the admin page). */
export const selfView = (user) => ({ ...publicUser(user, { self: true }), isAdmin: isAdminEmail(user.email) });
