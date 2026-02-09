/**
 * Shared helpers for Vercel serverless functions:
 * - Upstash Redis REST (no npm package needed)
 * - Auth check (Bearer token)
 * - CORS headers
 */

const REDIS_KEY = "kanban:board";

const DEFAULT_BOARD = {
  columns: [
    { id: "col-todo", title: "To Do", tasks: [] },
    { id: "col-progress", title: "In Progress", tasks: [] },
    { id: "col-done", title: "Done", tasks: [] },
  ],
  initiatives: [],
  backlog: [],
};

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function handleCors(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }
  return false;
}

// ── Auth ────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return true; // no header = browser = allow
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === process.env.KANBAN_API_TOKEN;
}

// ── Redis REST ──────────────────────────────────────────────────────────────

async function redisGet() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const resp = await fetch(`${url}/get/${REDIS_KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.result) {
    return JSON.parse(data.result);
  }
  return structuredClone(DEFAULT_BOARD);
}

async function redisSet(board) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(["SET", REDIS_KEY, JSON.stringify(board)]),
  });
}

// ── Response helpers ────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  json(res, { error: "Not found" }, 404);
}

function unauthorized(res) {
  json(res, { error: "Unauthorized" }, 401);
}

function badRequest(res, msg) {
  json(res, { error: msg }, 400);
}

// ── ID helper (matches api-server.js uid()) ─────────────────────────────────

function uid() {
  // crypto.randomUUID available in Node 18+ (Vercel runtime)
  return crypto.randomUUID().slice(0, 8);
}

module.exports = {
  DEFAULT_BOARD,
  CORS_HEADERS,
  handleCors,
  checkAuth,
  redisGet,
  redisSet,
  json,
  notFound,
  unauthorized,
  badRequest,
  uid,
};
