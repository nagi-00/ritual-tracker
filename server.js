require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ──────────────────────────────────────────────
// File-based persistent store (survives restart)
// ──────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (_) {}
  return { tokens: {} };
}

function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

let store = loadStore();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// Auth helper: extract configId from header or query
// ──────────────────────────────────────────────
function getNotionClient(req) {
  const configId = req.headers['x-config-id'] || req.query.configId;
  if (!configId) return null;
  const entry = store.tokens[configId];
  if (!entry || !entry.accessToken) return null;
  return new Client({ auth: entry.accessToken });
}

function requireAuth(req, res, next) {
  if (!getNotionClient(req)) {
    return res.status(401).json({ error: 'Not authenticated. Provide x-config-id header.' });
  }
  next();
}

// ──────────────────────────────────────────────
// Notion OAuth 2.0 Flow
// ──────────────────────────────────────────────

app.get('/auth/notion', (req, res) => {
  // Generate configId and store as pending
  const configId = crypto.randomBytes(16).toString('hex');
  store.tokens[configId] = { status: 'pending', createdAt: Date.now() };
  saveStore(store);

  const params = new URLSearchParams({
    client_id: process.env.NOTION_CLIENT_ID,
    response_type: 'code',
    owner: 'user',
    redirect_uri: process.env.NOTION_REDIRECT_URI || `${BASE_URL}/auth/notion/callback`,
    state: configId   // use configId as state
  });

  res.redirect(`https://api.notion.com/v1/oauth/authorize?${params}`);
});

app.get('/auth/notion/callback', async (req, res) => {
  const { code, state: configId, error } = req.query;

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }

  if (!configId || !store.tokens[configId]) {
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

    // Store token persistently
    store.tokens[configId] = {
      status: 'active',
      accessToken: data.access_token,
      workspaceId: data.workspace_id,
      workspaceName: data.workspace_name,
      workspaceIcon: data.workspace_icon,
      botId: data.bot_id,
      createdAt: Date.now()
    };
    saveStore(store);

    // Redirect with configId so the frontend can store it
    res.redirect(`/?auth_success=true&configId=${configId}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?auth_error=server_error');
  }
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
  const configId = req.headers['x-config-id'] || req.query.configId;
  if (!configId || !store.tokens[configId] || store.tokens[configId].status !== 'active') {
    return res.json({ authenticated: false });
  }
  const info = store.tokens[configId];
  res.json({
    authenticated: true,
    configId,
    workspaceName: info.workspaceName,
    workspaceIcon: info.workspaceIcon
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const configId = req.headers['x-config-id'];
  if (configId && store.tokens[configId]) {
    delete store.tokens[configId];
    saveStore(store);
  }
  res.json({ ok: true });
});

// ──────────────────────────────────────────────
// Notion Database Operations
// ──────────────────────────────────────────────

// Get accessible pages (for selecting parent page during setup)
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

// Create Morning Page / Gratitude Diary databases
app.post('/api/databases/setup', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { parentPageId } = req.body;

    if (!parentPageId) {
      return res.status(400).json({ error: 'parentPageId is required' });
    }

    // Morning Page DB
    const mpDb = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: 'Morning Page' } }],
      icon: { type: 'emoji', emoji: '🌅' },
      properties: {
        'Name': { title: {} },
        'Date': { date: {} },
        'Content': { rich_text: {} },
        'Mood': {
          select: {
            options: [
              { name: '😊 Good', color: 'green' },
              { name: '😐 Okay', color: 'yellow' },
              { name: '😔 Bad', color: 'red' },
              { name: '😴 Tired', color: 'gray' },
              { name: '🔥 Fired Up', color: 'orange' }
            ]
          }
        },
        'Completed': { checkbox: {} }
      }
    });

    // Gratitude Diary DB
    const gdDb = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: 'Gratitude Diary' } }],
      icon: { type: 'emoji', emoji: '🙏' },
      properties: {
        'Name': { title: {} },
        'Date': { date: {} },
        'Gratitude 1': { rich_text: {} },
        'Gratitude 2': { rich_text: {} },
        'Gratitude 3': { rich_text: {} },
        'Completed': { checkbox: {} }
      }
    });

    res.json({
      morningPageDbId: mpDb.id,
      gratitudeDbId: gdDb.id
    });
  } catch (err) {
    console.error('Setup databases error:', err);
    res.status(500).json({ error: 'Failed to create databases', details: err.message });
  }
});

// ──────────────────────────────────────────────
// Bulk page generation: today → end of month
// ──────────────────────────────────────────────
app.post('/api/generate-month', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { databaseId, type } = req.body;
    // type: 'morning-page' | 'gratitude'

    if (!databaseId || !type) {
      return res.status(400).json({ error: 'databaseId and type are required' });
    }

    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const startDay = today.getDate();
    const lastDay = new Date(year, month + 1, 0).getDate();

    // Check which dates already have pages
    const existingRes = await notion.databases.query({
      database_id: databaseId,
      filter: {
        and: [
          { property: 'Date', date: { on_or_after: `${year}-${String(month+1).padStart(2,'0')}-${String(startDay).padStart(2,'0')}` } },
          { property: 'Date', date: { on_or_before: `${year}-${String(month+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}` } }
        ]
      },
      page_size: 100
    });

    const existingDates = new Set();
    for (const page of existingRes.results) {
      const d = page.properties?.Date?.date?.start;
      if (d) existingDates.add(d);
    }

    const created = [];
    const skipped = [];

    for (let day = startDay; day <= lastDay; day++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

      if (existingDates.has(dateStr)) {
        skipped.push(dateStr);
        continue;
      }

      const titlePrefix = type === 'morning-page' ? 'Morning Page' : 'Gratitude Diary';
      const props = {
        'Name': { title: [{ text: { content: `${titlePrefix} ${dateStr}` } }] },
        'Date': { date: { start: dateStr } },
        'Completed': { checkbox: false }
      };

      if (type === 'morning-page') {
        props['Content'] = { rich_text: [] };
      } else {
        props['Gratitude 1'] = { rich_text: [] };
        props['Gratitude 2'] = { rich_text: [] };
        props['Gratitude 3'] = { rich_text: [] };
      }

      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: props
      });

      created.push(dateStr);

      // Rate limit: Notion allows ~3 requests/sec
      if (day < lastDay) await new Promise(r => setTimeout(r, 350));
    }

    res.json({
      ok: true,
      created: created.length,
      skipped: skipped.length,
      range: `${year}-${String(month+1).padStart(2,'0')}-${String(startDay).padStart(2,'0')} ~ ${year}-${String(month+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`
    });
  } catch (err) {
    console.error('Generate month error:', err);
    res.status(500).json({ error: 'Failed to generate monthly pages', details: err.message });
  }
});

// ──────────────────────────────────────────────
// Check today's completion status
// ──────────────────────────────────────────────
app.get('/api/status/today', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { morningPageDbId, gratitudeDbId } = req.query;
    const today = new Date().toISOString().split('T')[0];

    const result = {
      morningPage: false, morningPageId: null, morningPageContent: '',
      gratitudeDiary: false, gratitudeDiaryId: null
    };

    if (morningPageDbId) {
      const mp = await notion.databases.query({
        database_id: morningPageDbId,
        filter: { property: 'Date', date: { equals: today } },
        page_size: 1
      });
      if (mp.results.length > 0) {
        const page = mp.results[0];
        result.morningPageId = page.id;
        // Completed = true means user has written something
        result.morningPage = page.properties?.Completed?.checkbox === true;
        result.morningPageMood = page.properties?.Mood?.select?.name || '';
      }
    }

    if (gratitudeDbId) {
      const gd = await notion.databases.query({
        database_id: gratitudeDbId,
        filter: { property: 'Date', date: { equals: today } },
        page_size: 1
      });
      if (gd.results.length > 0) {
        const page = gd.results[0];
        result.gratitudeDiaryId = page.id;
        result.gratitudeDiary = page.properties?.Completed?.checkbox === true;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Check today status error:', err);
    res.status(500).json({ error: 'Failed to check today status' });
  }
});

// ──────────────────────────────────────────────
// Save Morning Page (find today's page → update)
// ──────────────────────────────────────────────
app.post('/api/morning-page', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { databaseId, content, mood, pageId } = req.body;
    const today = new Date().toISOString().split('T')[0];

    let targetPageId = pageId;

    // If no pageId provided, find today's page
    if (!targetPageId) {
      const existing = await notion.databases.query({
        database_id: databaseId,
        filter: { property: 'Date', date: { equals: today } },
        page_size: 1
      });

      if (existing.results.length > 0) {
        targetPageId = existing.results[0].id;
      } else {
        // No pre-created page exists, create one
        const page = await notion.pages.create({
          parent: { database_id: databaseId },
          properties: {
            'Name': { title: [{ text: { content: `Morning Page ${today}` } }] },
            'Date': { date: { start: today } },
            'Content': { rich_text: [{ text: { content: content || '' } }] },
            ...(mood ? { 'Mood': { select: { name: mood } } } : {}),
            'Completed': { checkbox: true }
          }
        });
        return res.json({ ok: true, pageId: page.id, created: true });
      }
    }

    // Update existing page
    const updateProps = {
      'Completed': { checkbox: true }
    };
    if (content !== undefined) {
      updateProps['Content'] = { rich_text: [{ text: { content: content || '' } }] };
    }
    if (mood) {
      updateProps['Mood'] = { select: { name: mood } };
    }

    await notion.pages.update({
      page_id: targetPageId,
      properties: updateProps
    });

    res.json({ ok: true, pageId: targetPageId, updated: true });
  } catch (err) {
    console.error('Save morning page error:', err);
    res.status(500).json({ error: 'Failed to save morning page', details: err.message });
  }
});

// ──────────────────────────────────────────────
// Save Gratitude Diary (find today's page → update)
// ──────────────────────────────────────────────
app.post('/api/gratitude', requireAuth, async (req, res) => {
  try {
    const notion = getNotionClient(req);
    const { databaseId, gratitude1, gratitude2, gratitude3, pageId } = req.body;
    const today = new Date().toISOString().split('T')[0];

    let targetPageId = pageId;

    if (!targetPageId) {
      const existing = await notion.databases.query({
        database_id: databaseId,
        filter: { property: 'Date', date: { equals: today } },
        page_size: 1
      });

      if (existing.results.length > 0) {
        targetPageId = existing.results[0].id;
      } else {
        const page = await notion.pages.create({
          parent: { database_id: databaseId },
          properties: {
            'Name': { title: [{ text: { content: `Gratitude Diary ${today}` } }] },
            'Date': { date: { start: today } },
            'Gratitude 1': { rich_text: [{ text: { content: gratitude1 || '' } }] },
            'Gratitude 2': { rich_text: [{ text: { content: gratitude2 || '' } }] },
            'Gratitude 3': { rich_text: [{ text: { content: gratitude3 || '' } }] },
            'Completed': { checkbox: true }
          }
        });
        return res.json({ ok: true, pageId: page.id, created: true });
      }
    }

    await notion.pages.update({
      page_id: targetPageId,
      properties: {
        'Gratitude 1': { rich_text: [{ text: { content: gratitude1 || '' } }] },
        'Gratitude 2': { rich_text: [{ text: { content: gratitude2 || '' } }] },
        'Gratitude 3': { rich_text: [{ text: { content: gratitude3 || '' } }] },
        'Completed': { checkbox: true }
      }
    });

    res.json({ ok: true, pageId: targetPageId, updated: true });
  } catch (err) {
    console.error('Save gratitude error:', err);
    res.status(500).json({ error: 'Failed to save gratitude diary', details: err.message });
  }
});

// ──────────────────────────────────────────────
// Weather Proxy
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
      icon: weatherCodeToEmoji(current.weatherCode)
    });
  } catch (err) {
    console.error('Weather error:', err);
    res.status(500).json({ error: 'Failed to fetch weather' });
  }
});

function weatherCodeToEmoji(code) {
  const c = parseInt(code);
  if (c === 113) return '\u2600\uFE0F';
  if (c === 116) return '\u26C5';
  if ([119,122].includes(c)) return '\u2601\uFE0F';
  if ([143,248,260].includes(c)) return '\uD83C\uDF2B\uFE0F';
  if ([176,263,266,293,296,353].includes(c)) return '\uD83C\uDF26\uFE0F';
  if ([299,302,305,308,356,359].includes(c)) return '\uD83C\uDF27\uFE0F';
  if ([200,386,389,392,395].includes(c)) return '\u26C8\uFE0F';
  if ([179,182,185,227,230,281,284,311,314,317,320,323,326,329,332,335,338,350,362,365,368,371,374,377].includes(c)) return '\u2744\uFE0F';
  return '\uD83C\uDF24\uFE0F';
}

// Fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ritual Tracker running at ${BASE_URL}`);
});
