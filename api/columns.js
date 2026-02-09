const { handleCors, checkAuth, redisGet, redisSet, json, unauthorized, uid } = require("./_lib/redis");

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  const board = await redisGet();

  // GET /api/columns — all columns
  if (req.method === "GET") {
    return json(res, board.columns);
  }

  // POST /api/columns — create column
  if (req.method === "POST") {
    const body = req.body;
    const col = { id: `col-${uid()}`, title: body.title || "New Column", tasks: [] };
    board.columns.push(col);
    await redisSet(board);
    return json(res, col, 201);
  }

  json(res, { error: "Method not allowed" }, 405);
};
