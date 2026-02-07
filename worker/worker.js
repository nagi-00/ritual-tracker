/**
 * Ritual Tracker — Notion OAuth Proxy (Cloudflare Worker)
 *
 * This worker handles:
 *   1. POST /auth/token   — Exchange OAuth code for access token
 *   2. POST /api/notion/* — Proxy requests to Notion API (bypasses CORS)
 *
 * Environment variables (set via `wrangler secret put`):
 *   NOTION_CLIENT_ID     — Your Notion OAuth app client ID
 *   NOTION_CLIENT_SECRET — Your Notion OAuth app client secret
 *
 * Deploy:
 *   npx wrangler deploy
 */

const NOTION_API = 'https://api.notion.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Notion-Token',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ===== 1. Token Exchange =====
    if (path === '/auth/token' && request.method === 'POST') {
      return handleTokenExchange(request, env);
    }

    // ===== 2. Notion API Proxy =====
    if (path.startsWith('/api/notion/') && request.method === 'POST') {
      return handleNotionProxy(request, path);
    }

    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'ritual-tracker-proxy' });
    }

    return errorResponse('Not found', 404);
  },
};

/**
 * Exchange authorization code for an access token.
 * The client_secret never leaves this worker.
 */
async function handleTokenExchange(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { code, redirect_uri } = body;
  if (!code) return errorResponse('Missing "code" parameter');
  if (!redirect_uri) return errorResponse('Missing "redirect_uri" parameter');

  const clientId = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorResponse('Server misconfigured: missing Notion credentials', 500);
  }

  // Notion token endpoint expects Basic auth: base64(client_id:client_secret)
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const tokenRes = await fetch(`${NOTION_API}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirect_uri,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    return jsonResponse(tokenData, tokenRes.status);
  }

  // Return token data to frontend
  // Contains: access_token, token_type, bot_id, workspace_name, workspace_icon, etc.
  return jsonResponse(tokenData);
}

/**
 * Proxy requests to Notion API.
 * Frontend sends the access token in X-Notion-Token header.
 * This avoids CORS issues with the Notion API.
 */
async function handleNotionProxy(request, path) {
  const token = request.headers.get('X-Notion-Token');
  if (!token) return errorResponse('Missing X-Notion-Token header', 401);

  // Strip /api/notion prefix to get the Notion API path
  const notionPath = path.replace('/api/notion', '');
  const notionUrl = `${NOTION_API}/v1${notionPath}`;

  let body = null;
  try {
    body = await request.text();
  } catch {
    // no body
  }

  const notionRes = await fetch(notionUrl, {
    method: request.method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: body || undefined,
  });

  const data = await notionRes.text();

  return new Response(data, {
    status: notionRes.status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
