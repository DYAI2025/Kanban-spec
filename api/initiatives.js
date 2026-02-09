const { handleCors, checkAuth, redisGet, redisSet, json, unauthorized, uid } = require("./_lib/redis");

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  const board = await redisGet();

  // GET /api/initiatives
  if (req.method === "GET") {
    return json(res, board.initiatives || []);
  }

  // POST /api/initiatives — create initiative
  if (req.method === "POST") {
    const body = req.body;
    const initiative = {
      id: `init-${uid()}`,
      title: body.title || "New Initiative",
      description: body.description || "",
      githubLink: body.githubLink || "",
      documents: body.documents || [],
      createdAt: new Date().toISOString(),
    };
    if (!board.initiatives) board.initiatives = [];
    board.initiatives.push(initiative);
    await redisSet(board);
    return json(res, initiative, 201);
  }

  json(res, { error: "Method not allowed" }, 405);
};
