require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { Client } = require('@notionhq/client');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax'
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory token store (use a database in production)
const tokenStore = new Map();

// ──────────────────────────────────────────────
// Notion OAuth 2.0 Flow
// ──────────────────────────────────────────────

// Step 1: Redirect to Notion authorization
app.get('/auth/notion', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.NOTION_CLIENT_ID,
    response_type: 'code',
    owner: 'user',
    redirect_uri: process.env.NOTION_REDIRECT_URI || `${BASE_URL}/auth/notion/callback`,
    state
  });

  res.redirect(`https://api.notion.com/v1/oauth/authorize?${params}`);
});

// Step 2: Handle callback from Notion
app.get('/auth/notion/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }

  if (state !== req.session.oauthState) {
    return res.redirect('/?auth_error=invalid_state');
  }

  try {
    const credentials = Buffer.from(
      `${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.NOTION_REDIRECT_URI || `${BASE_URL}/auth/notion/callback`
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Notion OAuth error:', err);
      return res.redirect('/?auth_error=token_exchange_failed');
    }

    const data = await response.json();

    // Generate a session token for the user
    const sessionToken = crypto.randomBytes(32).toString('hex');
    tokenStore.set(sessionToken, {
      accessToken: data.access_token,
      workspaceId: data.workspace_id,
      workspaceName: data.workspace_name,
      workspaceIcon: data.workspace_icon,
      botId: data.bot_id,
      owner: data.owner,
      createdAt: Date.now()
    });

    req.session.notionToken = sessionToken;

    // Redirect back to widget with success
    res.redirect('/?auth_success=true');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?auth_error=server_error');
  }
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
  const token = req.session.notionToken;
  if (!token || !tokenStore.has(token)) {
    return res.json({ authenticated: false });
  }
  const info = tokenStore.get(token);
  res.json({
    authenticated: true,
    workspaceName: info.workspaceName,
    workspaceIcon: info.workspaceIcon
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.session.notionToken;
  if (token) {
    tokenStore.delete(token);
    delete req.session.notionToken;
  }
  res.json({ ok: true });
});

// ──────────────────────────────────────────────
// Helper: Get Notion client for current session
// ──────────────────────────────────────────────

function getNotionClient(req) {
  const token = req.session.notionToken;
  if (!token || !tokenStore.has(token)) return null;
  const info = tokenStore.get(token);
  return new Client({ auth: info.accessToken });
}

function requireAuth(req, res, next) {
  if (!getNotionClient(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ──────────────────────────────────────────────
// Notion Database Operations
// ──────────────────────────────────────────────

// Search for accessible databases
app.get('/api/databases', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const response = await notion.search({
      filter: { value: 'database', property: 'object' },
      page_size: 50
    });
    const databases = response.results.map(db => ({
      id: db.id,
      title: db.title?.[0]?.plain_text || 'Untitled',
      icon: db.icon
    }));
    res.json({ databases });
  } catch (err) {
    console.error('Search databases error:', err);
    res.status(500).json({ error: 'Failed to search databases' });
  }
});

// Create Morning Page / Gratitude Diary databases
app.post('/api/databases/setup', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { parentPageId } = req.body;

    if (!parentPageId) {
      return res.status(400).json({ error: 'parentPageId is required' });
    }

    // Create Morning Page database
    const morningPageDb = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: 'Morning Page' } }],
      icon: { type: 'emoji', emoji: '🌅' },
      properties: {
        'Title': { title: {} },
        'Date': { date: {} },
        'Content': { rich_text: {} },
        'Mood': {
          select: {
            options: [
              { name: '😊 좋음', color: 'green' },
              { name: '😐 보통', color: 'yellow' },
              { name: '😔 나쁨', color: 'red' },
              { name: '😴 피곤', color: 'gray' },
              { name: '🔥 열정', color: 'orange' }
            ]
          }
        },
        'Completed': { checkbox: {} }
      }
    });

    // Create Gratitude Diary database
    const gratitudeDb = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: '감사일기 (Gratitude Diary)' } }],
      icon: { type: 'emoji', emoji: '🙏' },
      properties: {
        'Title': { title: {} },
        'Date': { date: {} },
        'Gratitude 1': { rich_text: {} },
        'Gratitude 2': { rich_text: {} },
        'Gratitude 3': { rich_text: {} },
        'Completed': { checkbox: {} }
      }
    });

    res.json({
      morningPageDbId: morningPageDb.id,
      gratitudeDbId: gratitudeDb.id
    });
  } catch (err) {
    console.error('Setup databases error:', err);
    res.status(500).json({ error: 'Failed to create databases', details: err.message });
  }
});

// Get accessible pages (for selecting parent page)
app.get('/api/pages', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const response = await notion.search({
      filter: { value: 'page', property: 'object' },
      page_size: 50
    });
    const pages = response.results.map(page => ({
      id: page.id,
      title: page.properties?.title?.title?.[0]?.plain_text
        || page.properties?.Name?.title?.[0]?.plain_text
        || 'Untitled',
      icon: page.icon
    }));
    res.json({ pages });
  } catch (err) {
    console.error('Search pages error:', err);
    res.status(500).json({ error: 'Failed to search pages' });
  }
});

// Check today's entry status
app.get('/api/status/today', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { morningPageDbId, gratitudeDbId } = req.query;
    const today = new Date().toISOString().split('T')[0];

    const result = { morningPage: false, gratitudeDiary: false };

    if (morningPageDbId) {
      const mp = await notion.databases.query({
        database_id: morningPageDbId,
        filter: { property: 'Date', date: { equals: today } },
        page_size: 1
      });
      result.morningPage = mp.results.length > 0;
      if (mp.results.length > 0) {
        result.morningPageId = mp.results[0].id;
      }
    }

    if (gratitudeDbId) {
      const gd = await notion.databases.query({
        database_id: gratitudeDbId,
        filter: { property: 'Date', date: { equals: today } },
        page_size: 1
      });
      result.gratitudeDiary = gd.results.length > 0;
      if (gd.results.length > 0) {
        result.gratitudeDiaryId = gd.results[0].id;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Check today status error:', err);
    res.status(500).json({ error: 'Failed to check today status' });
  }
});

// Save Morning Page entry
app.post('/api/morning-page', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { databaseId, content, mood } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const title = `모닝페이지 ${today}`;

    // Check if entry already exists for today
    const existing = await notion.databases.query({
      database_id: databaseId,
      filter: { property: 'Date', date: { equals: today } },
      page_size: 1
    });

    if (existing.results.length > 0) {
      // Update existing
      const pageId = existing.results[0].id;
      await notion.pages.update({
        page_id: pageId,
        properties: {
          'Content': { rich_text: [{ text: { content: content || '' } }] },
          ...(mood ? { 'Mood': { select: { name: mood } } } : {}),
          'Completed': { checkbox: true }
        }
      });
      res.json({ ok: true, pageId, updated: true });
    } else {
      // Create new
      const page = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          'Title': { title: [{ text: { content: title } }] },
          'Date': { date: { start: today } },
          'Content': { rich_text: [{ text: { content: content || '' } }] },
          ...(mood ? { 'Mood': { select: { name: mood } } } : {}),
          'Completed': { checkbox: true }
        }
      });
      res.json({ ok: true, pageId: page.id, created: true });
    }
  } catch (err) {
    console.error('Save morning page error:', err);
    res.status(500).json({ error: 'Failed to save morning page', details: err.message });
  }
});

// Save Gratitude Diary entry
app.post('/api/gratitude', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { databaseId, gratitude1, gratitude2, gratitude3 } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const title = `감사일기 ${today}`;

    const existing = await notion.databases.query({
      database_id: databaseId,
      filter: { property: 'Date', date: { equals: today } },
      page_size: 1
    });

    const props = {
      'Gratitude 1': { rich_text: [{ text: { content: gratitude1 || '' } }] },
      'Gratitude 2': { rich_text: [{ text: { content: gratitude2 || '' } }] },
      'Gratitude 3': { rich_text: [{ text: { content: gratitude3 || '' } }] },
      'Completed': { checkbox: true }
    };

    if (existing.results.length > 0) {
      const pageId = existing.results[0].id;
      await notion.pages.update({ page_id: pageId, properties: props });
      res.json({ ok: true, pageId, updated: true });
    } else {
      const page = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          'Title': { title: [{ text: { content: title } }] },
          'Date': { date: { start: today } },
          ...props
        }
      });
      res.json({ ok: true, pageId: page.id, created: true });
    }
  } catch (err) {
    console.error('Save gratitude error:', err);
    res.status(500).json({ error: 'Failed to save gratitude diary', details: err.message });
  }
});

// ──────────────────────────────────────────────
// Weather Proxy (avoid CORS issues)
// ──────────────────────────────────────────────

app.get('/api/weather', async (req, res) => {
  const { city } = req.query;
  if (!city) return res.status(400).json({ error: 'city is required' });

  try {
    const response = await fetch(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      { headers: { 'User-Agent': 'ritual-tracker-widget' } }
    );
    if (!response.ok) throw new Error('Weather API error');
    const data = await response.json();

    const current = data.current_condition?.[0];
    if (!current) throw new Error('No weather data');

    res.json({
      temp: current.temp_C,
      feelsLike: current.FeelsLikeC,
      humidity: current.humidity,
      weatherDesc: current.weatherDesc?.[0]?.value || '',
      weatherCode: current.weatherCode,
      windSpeed: current.windspeedKmph,
      icon: weatherCodeToEmoji(current.weatherCode)
    });
  } catch (err) {
    console.error('Weather fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch weather' });
  }
});

function weatherCodeToEmoji(code) {
  const c = parseInt(code);
  if (c === 113) return '☀️';
  if (c === 116) return '⛅';
  if ([119, 122].includes(c)) return '☁️';
  if ([143, 248, 260].includes(c)) return '🌫️';
  if ([176, 263, 266, 293, 296, 353].includes(c)) return '🌦️';
  if ([299, 302, 305, 308, 356, 359].includes(c)) return '🌧️';
  if ([200, 386, 389, 392, 395].includes(c)) return '⛈️';
  if ([179, 182, 185, 227, 230, 281, 284, 311, 314, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377].includes(c)) return '❄️';
  return '🌤️';
}

// ──────────────────────────────────────────────
// Fallback: serve index.html
// ──────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Ritual Tracker server running at ${BASE_URL}`);
  console.log(`OAuth callback: ${BASE_URL}/auth/notion/callback`);
});
