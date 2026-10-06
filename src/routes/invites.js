import { Router } from 'express';
import { Conversation, User, createSystemMessage, serializeConversation, userLabel, withConversationRefs } from '#shared';
import { HttpError, handle } from '../middleware/errors.js';
import { broadcastConversation, broadcastMessage } from '../realtime.js';

const MAX_GROUP_SIZE = 512;
const CODE = /^[A-Za-z0-9_-]{16,40}$/;

async function groupFor(code) {
  if (!CODE.test(code || '')) return null;
  return Conversation.findOne({ inviteCode: code, type: 'group' });
}

const router = Router();

/** What the link leads to (before joining): name, photo, description, member count. */
router.get(
  '/:code',
  handle(async (req, res) => {
    const conv = await groupFor(req.params.code);
    if (!conv) throw new HttpError(404, 'This invite link is no longer valid');
    res.json({
      group: {
        id: String(conv._id),
        name: conv.name,
        description: conv.description || '',
        avatarUrl: conv.avatarUrl || null,
        members: conv.participants.length,
      },
      member: !!conv.member(req.userId),
    });
  })
);

router.post(
  '/:code/join',
  handle(async (req, res) => {
    const conv = await groupFor(req.params.code);
    if (!conv) throw new HttpError(404, 'This invite link is no longer valid');
    if (!conv.member(req.userId)) {
      if (conv.participants.length >= MAX_GROUP_SIZE) throw new HttpError(400, 'This group is full');
      const now = new Date();
      // Atomic, so tapping twice never adds the person twice.
      const added = await Conversation.updateOne(
        { _id: conv._id, 'participants.user': { $ne: req.userId } },
        { $push: { participants: { user: req.userId, joinedAt: now, lastReadAt: now, lastDeliveredAt: now } } }
      );
      if (added.modifiedCount) {
        const me = await User.findById(req.userId, 'username phone').lean();
        const fresh = await Conversation.findById(conv._id);
        const { message } = await createSystemMessage(fresh, `${userLabel(me)} joined using this group's invite link`);
        broadcastMessage(message, fresh);
        await broadcastConversation(conv._id, { join: [req.userId] });
      }
    }
    const view = await withConversationRefs(Conversation.findById(conv._id));
    res.json({ conversation: serializeConversation(view, req.userId) });
  })
);

export default router;

const escapeHtml = (s = '') => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The public page behind a shared link (https, so it's tappable in any app): shows the group
 * and opens ChatApp at the invite. Nothing private: name, photo and member count only.
 */
export async function invitePage(req, res) {
  const conv = await groupFor(req.params.code).catch(() => null);
  const code = encodeURIComponent(req.params.code || '');
  const app = `intent://join/${code}#Intent;scheme=chatapp;package=com.jujatech.chatapp;end`;
  const name = conv ? escapeHtml(conv.name) : '';
  const photo = conv?.avatarUrl && /^https:\/\//.test(conv.avatarUrl) ? `<img src="${escapeHtml(conv.avatarUrl)}" alt="">` : '<div class="ph">👥</div>';
  res
    .status(conv ? 200 : 404)
    .set('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'")
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${conv ? `Join ${name}` : 'Invite link'} · ChatApp</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--text:#111b21;--muted:#54656f;--accent:#0b8f6a}
@media (prefers-color-scheme:dark){:root{--bg:#0b141a;--card:#1f2c34;--text:#e9edef;--muted:#8696a0;--accent:#21c08b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box}
.card{background:var(--card);border-radius:16px;padding:28px 24px;max-width:360px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
img,.ph{width:96px;height:96px;border-radius:50%;object-fit:cover;margin:0 auto 12px;display:grid;place-items:center;font-size:44px;background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
a.btn{display:block;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:12px;border-radius:999px}
small{display:block;color:var(--muted);margin-top:16px}
</style></head><body><main class="card">
${conv ? `${photo}<h1>${name}</h1><p>Group · ${conv.participants.length} member${conv.participants.length === 1 ? '' : 's'}</p>
<a class="btn" href="${app}">Open in ChatApp</a>
<small>You'll be asked to confirm before joining. Don't have the app? Ask whoever sent this link for the ChatApp APK.</small>`
    : '<div class="ph">🔗</div><h1>Link no longer valid</h1><p>This invite link was reset or the group no longer exists. Ask a group admin for a new one.</p>'}
</main></body></html>`);
}
