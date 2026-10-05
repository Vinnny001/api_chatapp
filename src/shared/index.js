// Code shared with the other backend repo (chat-api / chat-realtime). Both services read
// the same MongoDB collections, so keep src/shared/models and serialize.js identical in both.
export { config, corsOriginOption } from './config.js';
export { connectMongo } from './db.js';
export { signToken, verifyToken } from './auth.js';
export { rooms, EVENTS, UPLOAD_URL_PATTERN, INTERNAL_EVENTS_PATH } from './realtime.js';
export { User } from './models/User.js';
export { Conversation } from './models/Conversation.js';
export { Message, MESSAGE_TYPES, MAX_TEXT_LENGTH } from './models/Message.js';
export * from './serialize.js';
export * from './services.js';
export * from './people.js';
export {
  initPush,
  pushCallEnded,
  pushGroupCall,
  pushIncomingCall,
  pushNewMessage,
  pushReaction,
  pushReactionRemoved,
  pushRead,
} from './push.js';
