import { Device } from '#shared';
import { readRevokeLink, revokeDevices } from '../devices.js';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(res, status, title, body) {
  res
    .status(status)
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ChatApp</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--text:#111b21;--muted:#54656f;--danger:#d93025}
@media (prefers-color-scheme:dark){:root{--bg:#0b141a;--card:#1f2c34;--text:#e9edef;--muted:#8696a0;--danger:#f15c6d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,sans-serif;padding:16px;box-sizing:border-box}
.card{background:var(--card);border-radius:16px;padding:28px 24px;max-width:380px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:21px;margin:0 0 10px}p{color:var(--muted);margin:0 0 14px}
button{width:100%;border:0;border-radius:999px;padding:12px;font:600 16px system-ui,sans-serif;background:var(--danger);color:#fff;cursor:pointer}
</style></head><body><main class="card">${body}</main></body></html>`);
}

/**
 * "This wasn't me" from the new-sign-in email. GET only shows the question (mail scanners
 * open links); signing out needs the button (POST).
 */
export async function revokePage(req, res) {
  const link = readRevokeLink(req.params.token);
  const device = link && (await Device.findOne({ _id: link.deviceId, user: link.userId }).lean().catch(() => null));
  if (!device) return page(res, 404, 'Link expired', '<h1>This link has expired</h1><p>Open ChatApp → Settings → Linked devices to sign devices out.</p>');
  if (device.revokedAt) return page(res, 200, 'Signed out', `<h1>Already signed out</h1><p>${esc(device.name)} is no longer signed in to your account.</p>`);
  if (req.method === 'POST') {
    await revokeDevices(link.userId, [device._id]);
    return page(
      res,
      200,
      'Signed out',
      `<h1>Signed out</h1><p><strong>${esc(device.name)}</strong> can no longer use your account.</p><p>Now reset your password in the app (Forgot password?) so it can't sign in again.</p>`
    );
  }
  return page(
    res,
    200,
    'Sign out a device',
    `<h1>Sign out this device?</h1><p><strong>${esc(device.name)}</strong> signed in to your ChatApp account on ${esc(new Date(device.createdAt).toUTCString())}.</p><form method="post"><button type="submit">Sign it out</button></form>`
  );
}
