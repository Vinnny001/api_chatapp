// One-off import from the old app: MySQL `users` + `message_status` and the old MongoDB
// `messages` documents (sender/receiver phone numbers). Safe to run more than once:
// users are matched by email/phone and messages are keyed by their legacy id.
//
//   npm run migrate:mysql
//
// Reads DB_HOST/DB_USER/DB_PASSWORD/DB_NAME (old MySQL) from .env and writes into MONGO_URI.
// If the old messages live in a different MongoDB than MONGO_URI (e.g. old local DB -> Atlas),
// set LEGACY_MONGO_URI to that old database.
import mysql from 'mysql2/promise';
import mongoose from 'mongoose';
import { Conversation, Message, User, connectMongo } from '#shared';

const normalizePhone = (p) => String(p ?? '').replace(/[\s()-]/g, '');

await connectMongo();
const sql = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// 1) Users — bcrypt hashes from the old app work unchanged with bcryptjs.
const [users] = await sql.query('SELECT name, email, phone_number, gender, password FROM users');
const userIdByPhone = new Map();
let createdUsers = 0;
for (const row of users) {
  const phone = normalizePhone(row.phone_number);
  const email = String(row.email).toLowerCase().trim();
  let user = await User.findOne({ $or: [{ email }, { phone }] });
  if (!user) {
    user = await User.create({
      name: row.name || phone,
      email,
      phone,
      gender: ['Male', 'Female', 'Other'].includes(row.gender) ? row.gender : undefined,
      passwordHash: row.password,
    });
    createdUsers++;
  }
  userIdByPhone.set(String(row.phone_number), user._id);
  userIdByPhone.set(phone, user._id);
  // Some versions of the old app identified people by email instead of phone.
  userIdByPhone.set(email, user._id);
}
console.log(`users: ${users.length} found, ${createdUsers} created`);

const lookupUser = (id) =>
  userIdByPhone.get(String(id)) ||
  userIdByPhone.get(normalizePhone(id)) ||
  userIdByPhone.get(String(id ?? '').toLowerCase().trim());

// 2) Old delivery/read state, keyed by the old Mongo message id.
const [statusRows] = await sql.query('SELECT mongo_id, status FROM message_status');
const statusById = new Map(statusRows.map((r) => [String(r.mongo_id), r.status]));
await sql.end();

// 3) Messages — old documents are the ones without a `conversation` field.
const legacyConnection = process.env.LEGACY_MONGO_URI
  ? await mongoose.createConnection(process.env.LEGACY_MONGO_URI).asPromise()
  : mongoose.connection;
const legacy = legacyConnection
  .collection('messages')
  .find({ conversation: { $exists: false } })
  .sort({ timestamp: 1 });
const convs = new Map(); // directKey -> { conv, state: Map(userId -> {read, delivered, unread}) }
let migrated = 0;
let skipped = 0;

for await (const doc of legacy) {
  const senderId = lookupUser(doc.sender);
  const receiverId = lookupUser(doc.receiver);
  if (!senderId || !receiverId || String(senderId) === String(receiverId)) {
    skipped++;
    continue;
  }
  const at = doc.timestamp ? new Date(doc.timestamp) : doc._id.getTimestamp();
  const directKey = [String(senderId), String(receiverId)].sort().join(':');

  let entry = convs.get(directKey);
  if (!entry) {
    let conv = await Conversation.findOne({ directKey });
    if (!conv) {
      conv = new Conversation({
        type: 'direct',
        directKey,
        createdBy: senderId,
        participants: [senderId, receiverId].map((user) => ({ user, joinedAt: at, lastReadAt: at, lastDeliveredAt: at })),
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await conv.save({ timestamps: false });
    }
    entry = { conv, state: new Map() };
    convs.set(directKey, entry);
  }

  const message = new Message({
    conversation: entry.conv._id,
    sender: senderId,
    clientId: `legacy-${doc._id}`,
    type: 'text',
    text: doc.text || '',
    createdAt: at,
    updatedAt: at,
  });
  try {
    await message.save({ timestamps: false });
    migrated++;
  } catch (err) {
    if (err.code !== 11000) throw err;
    skipped++; // already imported on a previous run
    continue;
  }

  const status = statusById.get(String(doc._id)) || 'sent';
  const s = entry.state.get(String(receiverId)) || { read: null, delivered: null, unread: 0 };
  if (status === 'read') s.read = at;
  if (status === 'read' || status === 'delivered') s.delivered = at;
  if (status !== 'read') s.unread++;
  entry.state.set(String(receiverId), s);
  entry.last = { id: message._id, at };
  entry.first = entry.first && entry.first < at ? entry.first : at;
}

// 4) Receipt watermarks, unread counters and last message per conversation.
for (const { conv, state, last, first } of convs.values()) {
  if (!last) continue;
  const fresh = await Conversation.findById(conv._id);
  for (const p of fresh.participants) {
    // Older messages may be imported on a later run; members joined no later than the first one.
    if (first < p.joinedAt) p.joinedAt = first;
    const s = state.get(String(p.user));
    if (!s) continue;
    if (s.read && s.read > p.lastReadAt) p.lastReadAt = s.read;
    if (s.delivered && s.delivered > p.lastDeliveredAt) p.lastDeliveredAt = s.delivered;
    p.unreadCount += s.unread;
  }
  if (!fresh.lastMessageAt || last.at >= fresh.lastMessageAt) {
    fresh.lastMessage = last.id;
    fresh.lastMessageAt = last.at;
  }
  await fresh.save();
}

console.log(`messages: ${migrated} imported, ${skipped} skipped, ${convs.size} conversations`);
if (legacyConnection !== mongoose.connection) await legacyConnection.close();
await mongoose.disconnect();
