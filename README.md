# Oracle Status Dashboard

A real-time monitoring dashboard for Oracle Cloud Infrastructure (OCI), deployed via Cloudron.

## Features

- **OCI Status Monitoring** - Polls Oracle's official status API every 3 minutes
- **DownDetector Integration** - Tracks user-reported Oracle Cloud outages
- **Incident Feed** - Displays active and recent OCI incidents
- **Region View** - Global region status across all OCI data centers
- **RSS Ticker** - Oracle news and status updates scrolling in real-time
- **Endpoint Health Checks** - Monitors key Oracle service endpoints

## Deploy to Cloudron

### Option 1: From Docker Image (Recommended)

Once the GitHub Action runs, the image is available at:
```
ghcr.io/tavishawkes/oracledash:latest
```

In your Cloudron dashboard:
1. Go to **App Store** > **Add custom app** > **Install from Docker image**
2. Enter: `ghcr.io/tavishawkes/oracledash:latest`
3. Set subdomain (e.g., `oracle-dashboard`)
4. Click Install

### Option 2: Build Locally

```bash
# Requires Docker + Cloudron CLI
docker build -t oracle-status-dashboard .
cloudron build
cloudron install
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `/api/status` | All cached status data |
| `/api/oci` | OCI component status |
| `/api/incidents` | Active incidents |
| `/api/downdetector` | DownDetector reports |
| `/api/rss` | RSS feed items |
| `/api/refresh` | Force data refresh |
| `/api/health` | Health check |

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Data Sources:** OCI Status API, DownDetector, Oracle RSS feeds
- **Deployment:** Docker + Cloudron
