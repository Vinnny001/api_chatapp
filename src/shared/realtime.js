// Room naming and event names shared by the API (which asks the realtime service to emit
// over a private HTTP endpoint) and the realtime service (which owns the sockets).

export const rooms = {
  user: (id) => `user:${id}`,
  conv: (id) => `conv:${id}`,
  device: (id) => `device:${id}`, // one signed-in device (signed out on its own)
};

// Media/avatars must be files uploaded through the API: either Cloudinary delivery URLs
// (production) or the API's own /uploads route (local development without Cloudinary).
export const UPLOAD_URL_PATTERN =
  /^(\/uploads\/[\w.-]+|\/files\/[a-f0-9]{24}\/[\w.-]+|https:\/\/res\.cloudinary\.com\/[\w-]+\/(image|video|raw)\/upload\/[\w/.,=-]+)$/;

export const INTERNAL_EVENTS_PATH = '/internal/events';

export const EVENTS = {
  // server -> client
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_REMOVED: 'message:removed', // deleted "for me" (sent to the user's own devices)
  RECEIPT: 'receipt',
  TYPING: 'typing',
  PRESENCE: 'presence',
  CONVERSATION_UPSERT: 'conversation:upsert',
  CONVERSATION_REMOVED: 'conversation:removed',
  USER_UPDATED: 'user:updated',
  LOGIN_REQUEST: 'login:request', // a new device asks to sign in (to the account's devices)
  LOGIN_REQUEST_DONE: 'login:request:done',
  MLS_COMMIT: 'mls:commit', // a chat's encryption group changed epoch (catch up)
  MLS_WELCOME: 'mls:welcome', // this device was added to a chat's encryption group
  MLS_ROSTER: 'mls:roster', // a member's devices changed (re-check the group before sending)
  MLS_SYNC: 'mls:sync', // a message on the encrypted channel between my own devices
  CALL_INCOMING: 'call:incoming',
  CALL_ACCEPTED: 'call:accepted',
  CALL_REJECTED: 'call:rejected',
  CALL_ENDED: 'call:ended',
  CALL_SIGNAL: 'call:signal',
  CALL_HANDLED_ELSEWHERE: 'call:handled-elsewhere',
  // A group call started, someone joined, or it ended: { conversationId, groupCall | null }
  GROUP_CALL: 'groupcall:update',
};
