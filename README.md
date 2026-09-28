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

Every route except auth needs `Authorization: Bearer <token>`.

## File uploads

If the `CLOUDINARY_*` variables are set, uploads are stored in Cloudinary (folder `CLOUDINARY_FOLDER`) and the response `url` is a permanent `https://res.cloudinary.com/...` link. Use this on Render and other hosts whose disk is wiped on redeploy. Without them, files are saved to local `uploads/` and served from `/uploads/...`, which is fine for development.

Cloudinary free-plan limits: images and documents up to 10 MB, video and audio up to 100 MB (the API also enforces `MAX_UPLOAD_MB`). PDF and ZIP downloads only work once *Settings → Security → Allow delivery of PDF and ZIP files* is enabled in the Cloudinary console.

## Shared code

`src/shared/` (models, serializers, message logic) is duplicated in chat-realtime, because both services use the same MongoDB collections. When you change a model, change it in both repos.

## Importing data from the old app

```bash
npm run migrate:mysql
```

This reads the old MySQL users (`DB_*`) and the old MongoDB messages (`LEGACY_MONGO_URI`, or `MONGO_URI` if that's not set), then writes them into `MONGO_URI`. Old passwords keep working, and it's safe to run more than once.
