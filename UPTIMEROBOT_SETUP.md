# UptimeRobot — Mavryn keep-alive setup

1. Create/login to an UptimeRobot account.
2. Choose **Add New Monitor**.
3. Monitor type: **HTTP(s)**.
4. Friendly name: `Mavryn Health`.
5. URL: `https://YOUR-RENDER-SERVICE.onrender.com/api/health`
6. Monitoring interval: **5 minutes**.
7. Create the monitor.

Expected response:
```json
{"status":"ok","app":"Mavryn","time":"..."}
```

The endpoint performs a MongoDB `ping`, so both the web-service route and database path are exercised.

Do not point the monitor at a page that requires login. Use `/api/health`.
