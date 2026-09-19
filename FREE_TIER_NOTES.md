# Free-tier and uptime notes

## Render
Render Free Web Services currently spin down after 15 minutes without inbound traffic. HTTP requests and inbound WebSocket messages count as activity. The next request wakes the service. Free workspaces currently include 750 instance hours per month.

This is why Mavryn includes `/api/health` and a UptimeRobot setup guide.

## UptimeRobot
The free plan currently provides 50 monitors and 5-minute checks without requiring a credit card. A single monitor is enough for Mavryn.

## MongoDB Atlas
The Atlas M0 Free tier currently includes 512 MB of storage and is limited to about 100 operations/second. Free clusters are automatically paused after 30 days of inactivity with zero connections. Mavryn's health endpoint pings MongoDB so a normally monitored deployment does not look completely idle.

This strategy reduces idle pauses; it is not a guarantee against provider policy changes, quota exhaustion, account suspension, or outages.
