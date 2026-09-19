# Final deployment — no source ZIP edits required

## A. MongoDB Atlas
1. Create an Atlas M0 Free cluster.
2. Create a database user.
3. Add a network access rule that permits Render to connect.
4. Copy the connection string.

## B. GitHub
Push the entire project folder to a new repository. Keep `.env` out of GitHub.

## C. Render
1. Render Dashboard → New → Web Service.
2. Connect the GitHub repository.
3. Use the included `render.yaml`, or set:
   - Build: `npm install`
   - Start: `npm start`
   - Health check: `/api/health`
   - Plan: Free
4. Add environment variables:
   - `MONGODB_URI` = your Atlas URI
   - `MONGODB_DB` = `mavryn`
   - `JWT_SECRET` = a random string 32+ characters
   - `ADMIN_PASSWORD` = `pass-10101010.`
   - `NODE_ENV` = `production`
5. Deploy.

## D. First test
Open your Render HTTPS URL.
1. Log in as `A` with `pass-10101010.`
2. Create one regular account in a separate browser/private window.
3. Test a direct chat.
4. Test avatar upload.
5. Open the app in two browser windows and verify typing/presence/seen.

## E. UptimeRobot
Use `UPTIMEROBOT_SETUP.md` and monitor `/api/health` every 5 minutes.

## F. APK
1. Open `android/` in Android Studio.
2. Build the APK.
3. Install it on Android.
4. On first launch paste the final Render HTTPS URL.
5. The app stores the URL locally. No source-file edit is needed.

## Admin
`A` has all ordinary member features plus the Admin section. The Admin section can view account capacity, manage regular accounts, review reports and publish a private announcement.
