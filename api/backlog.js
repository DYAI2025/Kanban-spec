const { handleCors, checkAuth, redisGet, redisSet, json, unauthorized, badRequest, notFound, uid } = require("./_lib/redis");

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  const board = await redisGet();
  if (!board.backlog) board.backlog = [];

  // Extract project ID from URL path: /api/backlog/:id
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ['api', 'backlog', ':id']
  const projectId = parts[2] || null;

  // GET /api/backlog — all projects
  if (req.method === "GET" && !projectId) {
    return json(res, board.backlog);
  }

  // GET /api/backlog/:id — single project
  if (req.method === "GET" && projectId) {
    const project = board.backlog.find((p) => p.id === projectId);
    if (!project) return notFound(res);
    return json(res, project);
  }

  // POST /api/backlog — create project
  if (req.method === "POST") {
    const body = req.body;
    if (!body.title) return badRequest(res, "title is required");
    const project = {
      id: `proj-${uid()}`,
      title: body.title,
      description: body.description || "",
      githubLink: body.githubLink || "",
      documents: body.documents || [],
      specStatus: "none",
      spec: "",
      specTasks: [],
      createdAt: new Date().toISOString(),
    };
    board.backlog.push(project);
    await redisSet(board);
    return json(res, project, 201);
  }

  // PUT /api/backlog/:id — update project
  if (req.method === "PUT" && projectId) {
    const idx = board.backlog.findIndex((p) => p.id === projectId);
    if (idx === -1) return notFound(res);
    const body = req.body;
    const project = board.backlog[idx];
    if (body.title !== undefined) project.title = body.title;
    if (body.description !== undefined) project.description = body.description;
    if (body.githubLink !== undefined) project.githubLink = body.githubLink;
    if (body.documents !== undefined) project.documents = body.documents;
    if (body.specStatus !== undefined) project.specStatus = body.specStatus;
    if (body.spec !== undefined) project.spec = body.spec;
    if (body.specTasks !== undefined) project.specTasks = body.specTasks;
    board.backlog[idx] = project;
    await redisSet(board);
    return json(res, project);
  }

  // DELETE /api/backlog/:id — delete project
  if (req.method === "DELETE" && projectId) {
    const idx = board.backlog.findIndex((p) => p.id === projectId);
    if (idx === -1) return notFound(res);
    board.backlog.splice(idx, 1);
    await redisSet(board);
    return json(res, { deleted: true });
  }

  json(res, { error: "Method not allowed" }, 405);
};
