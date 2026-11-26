import crypto from 'node:crypto';
import { Router } from 'express';
import { handle } from '../middleware/errors.js';

// Servers that help two phones reach each other for a 1:1 call. Most networks need only STUN,
// but mobile data and many Wi-Fi routers block direct connections; then the call goes through a
// TURN relay. The relay only forwards the call's packets: they're encrypted between the two
// phones (DTLS-SRTP, with keys checked by each device), so it can't hear or see the call.
//
// Set ONE of these on the API service (the credentials never go into the app itself):
//  - Cloudflare (free tier): CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
//  - Metered.ca:             METERED_TURN_DOMAIN (e.g. yourapp.metered.live) + METERED_TURN_API_KEY
//  - Your own coturn:        TURN_URLS (comma-separated) + TURN_SECRET (its static-auth-secret)
//  - Fixed login:            TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL

const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const TTL_S = 24 * 3600;
const env = (k) => process.env[k]?.trim() || '';
const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

export const turnProvider = () =>
  env('CLOUDFLARE_TURN_KEY_ID') && env('CLOUDFLARE_TURN_API_TOKEN')
    ? 'cloudflare'
    : env('METERED_TURN_DOMAIN') && env('METERED_TURN_API_KEY')
      ? 'metered'
      : env('TURN_URLS') && env('TURN_SECRET')
        ? 'coturn'
        : env('TURN_URLS') && env('TURN_USERNAME')
          ? 'static'
          : null;

let cached = null; // { at, servers } for the providers that hand out shared credentials

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function relayServers(userId) {
  switch (turnProvider()) {
    case 'cloudflare': {
      const id = env('CLOUDFLARE_TURN_KEY_ID');
      const data = await fetchJson(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('CLOUDFLARE_TURN_API_TOKEN')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_S }),
      });
      const servers = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
      // (Browsers handle the :53 ports Cloudflare lists badly; leave them out.)
      return servers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length);
    }
    case 'metered': {
      const data = await fetchJson(`https://${env('METERED_TURN_DOMAIN')}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env('METERED_TURN_API_KEY'))}`);
      return Array.isArray(data) ? data : [];
    }
    case 'coturn': {
      // coturn's "TURN REST API": a login that expires, signed with the shared secret.
      const username = `${Math.floor(Date.now() / 1000) + TTL_S}:${userId}`;
      const credential = crypto.createHmac('sha1', env('TURN_SECRET')).update(username).digest('base64');
      return [{ urls: list(env('TURN_URLS')), username, credential }];
    }
    case 'static':
      return [{ urls: list(env('TURN_URLS')), username: env('TURN_USERNAME'), credential: env('TURN_CREDENTIAL') }];
    default:
      return [];
  }
}

const router = Router();

/** → { iceServers, ttl, relay }: what a phone needs to set up a call (relay: a TURN server is included). */
router.get(
  '/ice-servers',
  handle(async (req, res) => {
    let relay = [];
    const provider = turnProvider();
    try {
      if (provider === 'coturn') relay = await relayServers(req.userId);
      else if (cached && Date.now() - cached.at < (TTL_S / 2) * 1000) relay = cached.servers;
      else if (provider) {
        relay = await relayServers(req.userId);
        cached = { at: Date.now(), servers: relay };
      }
    } catch (err) {
      console.error(`[api] TURN (${provider}) credentials failed:`, err.message);
      relay = cached?.servers || []; // keep the last ones that worked
    }
    res.set('Cache-Control', 'no-store');
    res.json({ iceServers: [...STUN, ...relay], ttl: TTL_S / 2, relay: relay.length > 0 });
  })
);

export default router;
