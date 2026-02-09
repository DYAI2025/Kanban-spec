const { handleCors, checkAuth, redisGet, redisSet, json, notFound, unauthorized, badRequest, uid } = require("./_lib/redis");

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  // Parse path: /api/tasks, /api/tasks/:id, /api/tasks/:id/move
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean); // ['api', 'tasks', id?, 'move'?]
  const taskId = parts[2] || null;
  const action = parts[3] || null;

  const board = await redisGet();

  // GET /api/tasks — all tasks flat
  if (req.method === "GET" && !taskId) {
    const tasks = [];
    for (const col of board.columns) {
      for (const task of col.tasks) {
        tasks.push({ ...task, columnId: col.id, columnTitle: col.title });
      }
    }
    return json(res, tasks);
  }

  // POST /api/tasks — create task
  if (req.method === "POST" && !taskId) {
    const body = req.body;
    const col = board.columns.find((c) => String(c.id) === String(body.columnId));
    if (!col) return badRequest(res, "Column not found");
    const task = {
      id: `task-${uid()}`,
      title: body.title || "New Task",
      description: body.description || body.desc || "",
      color: body.color || 0,
      createdAt: new Date().toISOString(),
    };
    col.tasks.push(task);
    await redisSet(board);
    return json(res, task, 201);
  }

  // PUT /api/tasks/:id/move — move task
  if (req.method === "PUT" && taskId && action === "move") {
    const body = req.body;
    const targetCol = board.columns.find((c) => String(c.id) === String(body.targetColumnId));
    if (!targetCol) return badRequest(res, "Target column not found");

    for (const col of board.columns) {
      const idx = col.tasks.findIndex((t) => String(t.id) === String(taskId));
      if (idx !== -1) {
        const [task] = col.tasks.splice(idx, 1);
        task.movedAt = new Date().toISOString();
        targetCol.tasks.push(task);
        await redisSet(board);
        return json(res, { ...task, columnId: targetCol.id });
      }
    }
    return notFound(res);
  }

  // PUT /api/tasks/:id — update task
  if (req.method === "PUT" && taskId && !action) {
    const body = req.body;
    for (const col of board.columns) {
      const task = col.tasks.find((t) => String(t.id) === String(taskId));
      if (task) {
        if (body.title !== undefined) task.title = body.title;
        if (body.description !== undefined) task.description = body.description;
        if (body.desc !== undefined) task.description = body.desc;
        if (body.color !== undefined) task.color = body.color;
        await redisSet(board);
        return json(res, task);
      }
    }
    return notFound(res);
  }

  // DELETE /api/tasks/:id — delete task
  if (req.method === "DELETE" && taskId) {
    for (const col of board.columns) {
      const idx = col.tasks.findIndex((t) => String(t.id) === String(taskId));
      if (idx !== -1) {
        col.tasks.splice(idx, 1);
        await redisSet(board);
        return json(res, { deleted: true });
      }
    }
    return notFound(res);
  }

  json(res, { error: "Method not allowed" }, 405);
};
