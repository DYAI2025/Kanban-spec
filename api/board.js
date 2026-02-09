const { handleCors, checkAuth, redisGet, redisSet, json, unauthorized } = require("./_lib/redis");

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  if (req.method === "GET") {
    const board = await redisGet();
    return json(res, board);
  }

  if (req.method === "POST") {
    const incoming = req.body;
    // Preserve server-side backlog (managed via /api/backlog)
    const current = await redisGet();
    incoming.backlog = current.backlog || [];
    await redisSet(incoming);
    return json(res, { ok: true });
  }

  json(res, { error: "Method not allowed" }, 405);
};
