// Usernames and how a person is shown to people who haven't saved them.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

const RESERVED = new Set(['admin', 'administrator', 'chatapp', 'support', 'help', 'system', 'root', 'official', 'moderator', 'null', 'undefined']);

/**
 * Username rules: 3–30 characters; lowercase letters, numbers, "." and "_"; starts with a
 * letter; doesn't end with "." or "_"; no two dots in a row. Returns the problem, or null.
 */
export function usernameProblem(value) {
  const u = String(value ?? '');
  if (u.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters`;
  if (u.length > USERNAME_MAX) return `Username must be at most ${USERNAME_MAX} characters`;
  if (u !== u.toLowerCase()) return 'Username must be lowercase';
  if (!/^[a-z0-9._]+$/.test(u)) return 'Username can only use letters, numbers, "." and "_"';
  if (!/^[a-z]/.test(u)) return 'Username must start with a letter';
  if (/[._]$/.test(u)) return 'Username cannot end with "." or "_"';
  if (u.includes('..')) return 'Username cannot have two dots in a row';
  if (RESERVED.has(u)) return 'That username is not available';
  return null;
}

/** "@username", or the phone number for people without a username. */
export const userLabel = (u) => (u?.username ? `@${u.username}` : u?.phone || 'Someone');
