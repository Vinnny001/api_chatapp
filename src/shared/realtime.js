// Room naming and event names shared by the API (which asks the realtime service to emit
// over a private HTTP endpoint) and the realtime service (which owns the sockets).

export const rooms = {
  user: (id) => `user:${id}`,
  conv: (id) => `conv:${id}`,
};

// Media/avatars must point at files served by the API's own /uploads route.
export const UPLOAD_URL_PATTERN = /^\/uploads\/[\w.-]+$/;

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
  CALL_INCOMING: 'call:incoming',
  CALL_ACCEPTED: 'call:accepted',
  CALL_REJECTED: 'call:rejected',
  CALL_ENDED: 'call:ended',
  CALL_SIGNAL: 'call:signal',
  CALL_HANDLED_ELSEWHERE: 'call:handled-elsewhere',
};
