const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_API = 'https://api.notion.com';
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ritual-tracker-proxy' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ritual-tracker-proxy' });
});

// ===== Widget Config Storage =====

// Save config → returns short ID
app.post('/api/config', (req, res) => {
  const config = req.body;
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Invalid config' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const filePath = path.join(DATA_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config));
  res.json({ id });
});

// Load config by ID
app.get('/api/config/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{16}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid config ID' });
  }
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Config not found' });
  }
  const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  res.json(config);
});

// ===== Notion API Proxy =====
app.all('/api/notion/*', async (req, res) => {
  const token = req.headers['x-notion-token'];
  if (!token) return res.status(401).json({ error: 'Missing X-Notion-Token header' });

  const notionPath = req.path.replace('/api/notion', '');
  const notionUrl = `${NOTION_API}/v1${notionPath}`;

  const fetchOptions = {
    method: req.method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
  };

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    fetchOptions.body = JSON.stringify(req.body);
  }

  try {
    const notionRes = await fetch(notionUrl, fetchOptions);
    const data = await notionRes.text();
    res.status(notionRes.status).set('Content-Type', 'application/json').send(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to proxy request to Notion' });
  }
});

app.listen(PORT, () => {
  console.log(`Ritual Tracker proxy running on port ${PORT}`);
});
