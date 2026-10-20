import { Router } from 'express';
import { USER_FIELDS, User, publicUser, sameId } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { phoneVariants } from '../phone.js';

// "Chat with me" links (like wa.me): https://<api>/chat/<username or phone>?text=<message>.
// On Android with ChatApp installed the link opens the app directly (a verified App Link, see
// assetLinks), at the chat with that person and the message typed in (never sent by itself).
// Otherwise this page shows who it is, with "Open in ChatApp" and "Continue in the browser".

const PACKAGE = 'com.jujatech.chatapp';
const WEB_URL = () => (process.env.WEB_URL || 'https://frontend-chatapp-pearl.vercel.app').replace(/\/$/, '');
// SHA-256 fingerprints of the keys the Android app is signed with (comma-separated). The default
// is the debug key the APK is built with now; add the release key's when there is one.
const FINGERPRINTS = () =>
  (process.env.ASSETLINKS_SHA256 || 'C9:84:3D:14:CF:53:D2:83:C1:0A:49:47:03:26:4E:56:6E:C6:5F:3F:03:87:49:61:43:DC:7E:2F:D3:5D:3B:0A')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

/** /.well-known/assetlinks.json: lets Android open this site's /chat and /join links in the app. */
export function assetLinks(_req, res) {
  res.set('Cache-Control', 'public, max-age=3600').json([
    { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: FINGERPRINTS() } },
  ]);
}

/** Who a link points to: "@username" / "username", or a phone number in any format. */
async function findLinked(who) {
  const raw = decodeURIComponent(String(who || '')).trim();
  if (!raw) return null;
  const digits = raw.replace(/[\s()-]/g, '');
  if (/^\+?\d{7,15}$/.test(digits)) {
    const variants = phoneVariants(digits.startsWith('+') ? digits : `+${digits}`).concat(phoneVariants(digits));
    return User.findOne({ phone: { $in: [...new Set(variants)] }, disabled: { $ne: true } }, USER_FIELDS).lean();
  }
  const username = raw.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{3,30}$/.test(username)) return null;
  return User.findOne({ username, disabled: { $ne: true } }, USER_FIELDS).lean();
}

const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The page behind a chat link (when the app didn't open it): who, and how to open the chat. */
export async function chatLinkPage(req, res) {
  const user = await findLinked(req.params.who).catch(() => null);
  const text = String(req.query.text || '').slice(0, 2000);
  const who = encodeURIComponent(req.params.who || '');
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  const web = `${WEB_URL()}/?chat=${who}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
  const app = `intent://chat/${who}${q}#Intent;scheme=chatapp;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(web)};end`;
  // Only what anyone can see: the @username, or the number the link itself carries.
  const name = user ? escapeHtml(user.username ? `@${user.username}` : decodeURIComponent(req.params.who)) : '';
  const photo = user?.avatarUrl && /^https:\/\//.test(user.avatarUrl) ? `<img src="${escapeHtml(user.avatarUrl)}" alt="">` : '<div class="ph">💬</div>';
  res
    .status(user ? 200 : 404)
    .set('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'")
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${user ? `Chat with ${name}` : 'Chat link'} · ChatApp</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--text:#111b21;--muted:#54656f;--accent:#0b8f6a}
@media (prefers-color-scheme:dark){:root{--bg:#0b141a;--card:#1f2c34;--text:#e9edef;--muted:#8696a0;--accent:#21c08b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box}
.card{background:var(--card);border-radius:16px;padding:28px 24px;max-width:360px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
img,.ph{width:96px;height:96px;border-radius:50%;object-fit:cover;margin:0 auto 12px;display:grid;place-items:center;font-size:44px;background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}
.msg{background:var(--bg);border-radius:10px;padding:10px 12px;text-align:left;color:var(--text);margin:0 0 16px;white-space:pre-wrap;word-break:break-word}
a.btn{display:block;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:12px;border-radius:999px;margin-top:10px}
a.alt{display:block;color:var(--accent);text-decoration:none;font-weight:600;padding:12px;margin-top:4px}
</style></head><body><main class="card">
${user ? `${photo}<h1>Chat with ${name}</h1><p>on ChatApp</p>${text ? `<div class="msg">${escapeHtml(text)}</div>` : ''}
<a class="btn" href="${escapeHtml(app)}">Open in ChatApp</a>
<a class="alt" href="${escapeHtml(web)}">Continue in the browser</a>`
    : '<div class="ph">🔗</div><h1>Link not valid</h1><p>Nobody on ChatApp goes by this name or number.</p>'}
</main></body></html>`);
}

const router = Router();

/** The app opening a chat link: who it is (only what they let people see). */
router.get(
  '/chat/:who',
  handle(async (req, res) => {
    const u = await findLinked(req.params.who);
    if (!u || (u.blocked || []).some((b) => sameId(b, req.userId))) throw new HttpError(404, 'Nobody on ChatApp goes by this name or number');
    res.json({ user: publicUser(u) });
  })
);

export default router;
