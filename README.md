# Mavryn — Private 10-Account Realtime Messenger

Mavryn is a full-stack, browser-based realtime messenger designed for one private space with exactly **1 administrator + up to 9 regular accounts**.

## Stack
- Node.js + Express 5
- Socket.IO realtime messaging/signalling
- MongoDB Atlas Free (M0) for persistent data
- MongoDB GridFS for profile photos and small message/story media
- Render Free Web Service for hosting
- UptimeRobot Free for 5-minute monitoring/keep-alive
- PWA install support
- Android WebView wrapper for APK builds

## Account model
- `A` is the reserved administrator name.
- The administrator password is provided through the `ADMIN_PASSWORD` environment variable. Use the requested bootstrap value: `pass-10101010.`
- Exactly nine additional account slots are available.
- Registration is rejected after the total active-account count reaches 10.
- Deleting a regular account frees its slot.
- Regular users cannot claim `A`.

## Core features
Realtime text messaging, sent/delivered/seen state, typing/presence, rich attachments, voice messages, replies, edit/delete, reactions, pin/save/forward, direct chats, groups/circles, group membership and invite codes, stories with automatic expiry, voice/video call signalling with WebRTC, screen sharing, search, browser notifications, profile customization, realtime avatars, password management, recovery questions, blocking/reporting, privacy settings, themes, PWA installation and an administrator-only control panel.

## Free hosting design
The application is intentionally designed around free tiers. It does not rely on a paid Render instance or Render local filesystem. Persistent data is stored in MongoDB. Render Free services can spin down after 15 minutes with no inbound traffic, so the setup uses an external 5-minute health monitor. This reduces cold starts but is not a provider-level uptime guarantee. See `FREE_TIER_NOTES.md` and `UPTIMEROBOT_SETUP.md`.

## Local setup
1. Copy `.env.example` to `.env`.
2. Put your MongoDB Atlas URI in `MONGODB_URI`.
3. Set a random `JWT_SECRET` at least 32 characters long.
4. Set `ADMIN_PASSWORD=pass-10101010.` for the requested admin login.
5. Run `npm install`.
6. Run `npm start`.
7. Open `http://localhost:10000`.

For development use `npm run dev`.

## Render deployment
Use the included `render.yaml` or create one Web Service manually.
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Plan: Free

Required environment variables on Render:
- `MONGODB_URI`
- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `MONGODB_DB=mavryn`
- `NODE_ENV=production`

The application listens on Render's `PORT` automatically.

## MongoDB Atlas
Create one M0 Free cluster and one database named `mavryn`. Add a database user. For a Render-hosted server, configure the Atlas network access rules to allow Render to connect. A simple prototype configuration is `0.0.0.0/0` with strong database credentials; restrict this further when you move beyond the free prototype.

## UptimeRobot
After the Render service is live, create a free HTTP monitor for:
`https://YOUR-SERVICE.onrender.com/api/health`

Use a 5-minute interval. The health endpoint pings MongoDB and returns JSON when the database is reachable.

## APK
Open `android/` in Android Studio, build the APK, install it, and enter the final HTTPS Render URL on first launch. The URL is stored on-device, so the source ZIP does not need editing just to point the APK at your deployment.

## Important limitations
- This is a 10-member private app, not a public-scale social network.
- Render Free has finite monthly compute hours and can spin down when idle.
- MongoDB Atlas M0 is limited in storage and throughput.
- GridFS media is intentionally limited per file to keep the private free deployment practical.
- A free tier is not a contractual guarantee of permanent availability; provider limits/terms can change.

## Verification
Run:
- `npm run check`
- `npm run smoke`
"# Mavryn" 
"# Mavryn" 
