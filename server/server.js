const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_API = 'https://api.notion.com';

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ritual-tracker-proxy' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ritual-tracker-proxy' });
});

// Token Exchange
app.post('/auth/token', async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing "code" parameter' });
  if (!redirect_uri) return res.status(400).json({ error: 'Missing "redirect_uri" parameter' });

  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Server misconfigured: missing Notion credentials' });
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const tokenRes = await fetch(`${NOTION_API}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
      }),
    });

    const tokenData = await tokenRes.json();
    res.status(tokenRes.status).json(tokenData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// Notion API Proxy
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
