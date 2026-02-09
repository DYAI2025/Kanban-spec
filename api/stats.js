const { handleCors, checkAuth, redisGet, json, unauthorized } = require("./_lib/redis");

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  if (req.method !== "GET") {
    return json(res, { error: "Method not allowed" }, 405);
  }

  const board = await redisGet();
  const stats = {};
  for (const col of board.columns) {
    stats[col.title] = col.tasks.length;
  }
  stats.total = board.columns.reduce((sum, col) => sum + col.tasks.length, 0);
  stats.initiatives = (board.initiatives || []).length;
  return json(res, stats);
};
