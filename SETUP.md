# Ritual Tracker — Setup Guide

## Architecture

```
┌──────────────┐     OAuth popup     ┌─────────────────┐
│   Browser     │ ──────────────────> │   Notion OAuth   │
│  (index.html) │ <── redirect ────── │   (notion.so)    │
│               │                     └─────────────────┘
│               │     POST /auth/token
│               │ ──────────────────> ┌─────────────────┐
│               │ <── access_token ── │  CF Worker Proxy │
│               │                     │  (worker.js)     │
│               │  POST /api/notion/* │                  │
│               │ ──────────────────> │  → Notion API    │
│               │ <── response ────── │                  │
└──────────────┘                     └─────────────────┘
```

**Key point**: The `client_secret` is stored as an environment variable on the Cloudflare Worker. The user's browser never sees it. The `access_token` is stored only in the user's `localStorage`.

## Step 1: Create a Notion Integration

1. Go to https://www.notion.so/my-integrations
2. Click **"New integration"**
3. Fill in:
   - **Name**: Ritual Tracker
   - **Type**: **Public** (required for OAuth)
   - **Redirect URI**: Your deployed `index.html` URL (e.g. `https://yoursite.com/index.html`)
4. Save and note the **Client ID** and **Client Secret**

## Step 2: Deploy the Cloudflare Worker

```bash
cd worker/

# Install wrangler (if not installed)
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Set secrets
npx wrangler secret put NOTION_CLIENT_ID
# paste your client ID

npx wrangler secret put NOTION_CLIENT_SECRET
# paste your client secret

# Deploy
npx wrangler deploy
```

Note the deployed URL (e.g. `https://ritual-tracker-proxy.yourname.workers.dev`).

## Step 3: Configure the Frontend

Open `index.html` and set the two constants at the top of the `<script>`:

```js
const OAUTH_PROXY_URL = 'https://ritual-tracker-proxy.yourname.workers.dev';
const NOTION_CLIENT_ID = 'your-notion-client-id';
```

## Step 4: Prepare Notion Database

Create a Notion database with these properties:

| Property | Type   | Purpose                         |
|----------|--------|---------------------------------|
| Name     | Title  | Auto-filled: "Morning Page — 2026-02-07" |
| Type     | Select | "Morning Page" or "Daily Diary" |
| Date     | Date   | Entry date                      |
| Mood     | Select | great / good / okay / bad / awful |

Then share the database with your "Ritual Tracker" integration.

## Step 5: Use

1. Host `index.html` (GitHub Pages, Vercel, etc.)
2. Open the page → complete onboarding
3. On Step 3, click **"Connect with Notion"**
4. Authorize in the Notion popup
5. Select your database
6. Launch the widget!

## Embedding in Notion

Use Notion's `/embed` block and paste the URL of your hosted `index.html`.

## Local-only Mode

If you skip Notion connection, all data is stored in `localStorage` only. No network requests are made (except weather).
