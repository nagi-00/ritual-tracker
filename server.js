require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// File-based config store (persists across restarts)
// ──────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'configs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfigs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8');
}

let configs = loadConfigs();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for widget embedding
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Notion-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ──────────────────────────────────────────────
// Config Store Endpoints
// ──────────────────────────────────────────────

// Save config → returns { id }
app.post('/api/config', (req, res) => {
  const id = crypto.randomBytes(8).toString('hex');
  configs[id] = req.body;
  saveConfigs(configs);
  res.json({ id });
});

// Retrieve config by id
app.get('/api/config/:id', (req, res) => {
  const cfg = configs[req.params.id];
  if (!cfg) return res.status(404).json({ error: 'Config not found' });
  res.json(cfg);
});

// ──────────────────────────────────────────────
// Notion API Proxy
// Forwards requests to https://api.notion.com/v1/*
// Expects X-Notion-Token header from client
// ──────────────────────────────────────────────
app.all('/api/notion/*', async (req, res) => {
  const notionToken = req.headers['x-notion-token'];
  if (!notionToken) {
    return res.status(401).json({ error: 'X-Notion-Token header is required' });
  }

  // Extract the Notion API path after /api/notion/
  const notionPath = req.params[0];
  const notionUrl = `https://api.notion.com/v1/${notionPath}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(notionUrl, fetchOpts);
    const text = await response.text();

    res.status(response.status);
    res.header('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Notion proxy error:', err);
    res.status(502).json({ error: 'Failed to proxy request to Notion API', details: err.message });
  }
});

// Fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ritual Tracker running on port ${PORT}`);
});
