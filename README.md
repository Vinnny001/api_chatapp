# chat-api

REST service for ChatApp: sign up / login (JWT), profiles, user search, direct chats and groups, message history and search, starred messages, and file uploads.

It works with two other repos:
- **chat-realtime**: the Socket.IO service. This API sends it live events through its private `POST /internal/events` endpoint.
- **chat-frontend**: the React / Capacitor client.

## Setup

```bash
npm install
cp .env.example .env     # set MONGO_URI, JWT_SECRET, INTERNAL_SECRET
npm run dev              # http://localhost:5050
```

`JWT_SECRET` and `INTERNAL_SECRET` must be identical in chat-api and chat-realtime.

## Endpoints

| Method | Path | |
| --- | --- | --- |
| POST | `/api/auth/signup`, `/api/auth/login` | Returns `{ token, user }` |
| GET | `/api/auth/me` | Current user |
| GET / PATCH | `/api/users/search?q=`, `/api/users/me`, `/api/users/:id` | Profiles |
| GET / POST | `/api/conversations`, `/api/conversations/direct`, `/api/conversations/group` | Chats |
| PATCH | `/api/conversations/:id`, `/api/conversations/:id/prefs` | Group settings, pin/mute/archive |
| POST / PATCH / DELETE | `/api/conversations/:id/members[/:userId]` | Group members |
| GET | `/api/conversations/:id/messages?before=&limit=`, `/search?q=`, `/media` | History |
| POST | `/api/conversations/:id/clear` | Clear chat for me |
| GET / POST | `/api/messages/starred`, `/api/messages/:id/star` | Stars |
| POST | `/api/uploads` | Multipart `file` field, returns `{ url, name, size, mime }` |
| POST | `/api/users/lookup` | `{ phones: [...] }` → which numbers belong to registered users (contacts sync, tapped numbers) |
| POST | `/api/conversations/:id/messages` | Send over HTTP (used by the Android background sender); same `clientId` is never stored twice |

Every route except auth needs `Authorization: Bearer <token>`.

## File uploads

If the `CLOUDINARY_*` variables are set, uploads are stored in Cloudinary (folder `CLOUDINARY_FOLDER`) and the response `url` is a permanent `https://res.cloudinary.com/...` link. Use this on Render and other hosts whose disk is wiped on redeploy. Without them, files are saved to local `uploads/` and served from `/uploads/...`, which is fine for development.

Cloudinary free-plan limits: images and documents up to 10 MB, video and audio up to 100 MB (the API also enforces `MAX_UPLOAD_MB`). PDF and ZIP downloads only work once *Settings → Security → Allow delivery of PDF and ZIP files* is enabled in the Cloudinary console.

## Phone numbers

New accounts store numbers in international form (`+2547...`). Login, search, duplicate checks and `/lookup` accept any spelling (`0712...`, `254712...`, `+254 712 ...`) and also match older accounts saved as `07...`. Local numbers are assumed to use `DEFAULT_COUNTRY_CODE` (default `254`).

## Shared code

`src/shared/` (models, serializers, message logic) is duplicated in chat-realtime, because both services use the same MongoDB collections. When you change a model, change it in both repos.

## Importing data from the old app

```bash
npm run migrate:mysql
```

This reads the old MySQL users (`DB_*`) and the old MongoDB messages (`LEGACY_MONGO_URI`, or `MONGO_URI` if that's not set), then writes them into `MONGO_URI`. Old passwords keep working, and it's safe to run more than once.

## Email confirmation and password reset

New accounts confirm their email with a 6-digit code before they can use the app: sign-up and sign-in return a *pending* token (`verificationRequired: true`) that only works for `POST /api/auth/verify-email {code}` and `POST /api/auth/resend-code` (once a minute); confirming returns a normal token. `POST /api/auth/forgot {email}` emails a reset code (same answer whether or not the email has an account) and `POST /api/auth/reset {email, code, password}` sets a new password and signs in. Codes expire after 15 minutes and allow 5 tries. Accounts created before this feature count as confirmed.

Emails go through Brevo's HTTP API (Render's free plan blocks SMTP): set `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` (confirmed in Brevo → Senders) and optionally `BREVO_SENDER_NAME`. Without a key, emails are printed to the server log (development).

## Block and report

- `POST|DELETE /api/users/:id/block`, `GET /api/users/me/blocked`. Like WhatsApp, the blocked person isn't told: their messages in the one-to-one chat stay one tick and are never delivered (stored hidden from the blocker), their calls never ring, and they stop seeing the blocker's photo, about, online status and last seen. The blocker can't message or call them until unblocking. Groups aren't affected.
- `POST /api/users/:id/report {reason, details, conversationId, block}` stores a report with the person's last 5 messages in that chat, for the admin page.

## Usernames and privacy

- Last seen is reciprocal: a user with `showLastSeen: false` gets `lastSeen: null` for everyone else (conversations, profiles, search, contacts, presence).
- Group calls (LiveKit): set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (LiveKit Cloud → project → API keys). `POST /api/conversations/:id/group-call {kind}` starts or joins the group's call and returns `{ url, token }` for the app; `POST /api/conversations/:id/group-call/leave` ends it when the last person leaves. Members are rung by push; the call is logged in the chat; calls everyone dropped out of are ended by a sweeper every minute.
- Shared content: `GET /api/conversations/shared?kind=all|media|docs|links|apps|starred&q=&before=&conversationId=&counts=1` lists media, documents, links, APKs and starred messages, for one chat or all chats, newest first.
- Reactions: `POST /api/messages/:id/react {emoji|null}` (also over the realtime socket). The author gets a `reaction` push (and `reaction_removed`); conversations carry `lastReaction` for the chat list.
- Uploads up to `MAX_UPLOAD_MB` (default 50). Non-media files over Cloudinary's 10 MB limit, and APKs (which Cloudinary refuses), are stored on Cloudinary in parts and served as one download from `GET /files/:id/:name`.

- `POST /api/conversations/direct` with your own id opens your chat with yourself (one member).
- Message pushes include the whole message (`message`, JSON) when it fits in a push (4 KB), so the phone can show it offline.

- A user's registered **name is private**: other people never receive it. They see the name they saved the person under (phone address book, or ChatApp contacts), else the **@username**, else the **phone number**.
- **Usernames** are optional (at sign-up, or later in Settings) and can be changed. Rules: 3–30 characters; lowercase letters, numbers, `.` and `_`; starts with a letter; doesn't end with `.` or `_`; no `..`. `GET /api/auth/username/:username` checks availability.
- The **phone number** is shared only by users without a username, or who turn on *Show my phone number* (off by default). The **email** is shared only with *Share my email* (off by default). People who already have the number in their address book still match it through `POST /api/users/lookup`.
- **Search** (`GET /api/users/search`) finds people by username prefix, by their full phone number, or by a shared email; not by name or part of a number.
- **Saved contacts**: `GET /api/users/me/contacts`, `PUT /api/users/me/contacts/:userId {name}`, `DELETE /api/users/me/contacts/:userId`.

## Push notifications

New messages are pushed to the recipients' phones through Firebase Cloud Messaging, so they arrive as pop-up notifications even when the app is closed. Muted chats and the sender's own devices are skipped. Set `FIREBASE_SERVICE_ACCOUNT` to the service-account key from Firebase (*Project settings → Service accounts → Generate new private key*): paste the whole JSON on one line, or base64-encode it. Set the same value on both **chat-api** and **chat-realtime**. Without it, the service runs normally but sends no notifications.

The pushes are data-only: the Android app builds the notifications itself (one per chat that stacks its messages with the sender's photo, Reply and Mark as read buttons; a ringing full-screen notification for calls). Besides new messages the services push `read` (clears a chat's notification on your other phones), `call` (rings the phone) and `call_end` (stops the ringing; shows "Missed call" when unanswered).

Endpoints used by those notification buttons: `POST /api/conversations/:id/read` (Mark as read) and the normal send endpoint (Reply). `GET /api/conversations/calls` returns the call history (the app's Calls list). Messages can be up to 65,536 characters.
