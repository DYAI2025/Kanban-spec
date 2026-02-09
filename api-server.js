#!/usr/bin/env node

/**
 * Kanban Board API Server
 *
 * Lightweight Express API that persists board data in a JSON file.
 * The static frontend (index.html) continues to serve via `serve` on port 3000.
 * This API runs on port 3001 and provides CRUD operations for the Coach agent.
 *
 * Data file: ./board-data.json
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3002;
const DATA_FILE = path.join(__dirname, "board-data.json");

// Default board structure
const DEFAULT_BOARD = {
  columns: [
    { id: "col-todo", title: "To Do", tasks: [] },
    { id: "col-progress", title: "In Progress", tasks: [] },
    { id: "col-done", title: "Done", tasks: [] },
  ],
  initiatives: [],
};

function loadBoard() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Error loading board data:", e.message);
  }
  return structuredClone(DEFAULT_BOARD);
}

function saveBoard(board) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(board, null, 2), "utf8");
}

function uid() {
  return crypto.randomUUID().slice(0, 8);
}

// Extract agent info from task description (---agent-meta--- block)
function extractAgentFromDescription(desc) {
  if (!desc) return null;
  const match = desc.match(/---agent-meta---\s*\{[^}]*"agent"\s*:\s*"([^"]+)"[^}]*\}/);
  return match ? match[1] : null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  json(res, { error: "Not found" }, 404);
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ['api', 'board'] etc.

  if (parts[0] !== "api") return notFound(res);

  const board = loadBoard();
  const resource = parts[1];

  try {
    // GET /api/board — full board
    if (resource === "board" && req.method === "GET") {
      return json(res, board);
    }

    // GET /api/columns — all columns
    if (resource === "columns" && req.method === "GET") {
      return json(res, board.columns);
    }

    // POST /api/columns — create column
    if (resource === "columns" && req.method === "POST") {
      const body = await parseBody(req);
      const col = { id: `col-${uid()}`, title: body.title || "New Column", tasks: [] };
      board.columns.push(col);
      saveBoard(board);
      return json(res, col, 201);
    }

    // GET /api/tasks — all tasks flat
    if (resource === "tasks" && req.method === "GET" && !parts[2]) {
      const tasks = [];
      for (const col of board.columns) {
        for (const task of col.tasks) {
          tasks.push({ ...task, columnId: col.id, columnTitle: col.title });
        }
      }
      return json(res, tasks);
    }

    // POST /api/tasks — create task
    if (resource === "tasks" && req.method === "POST") {
      const body = await parseBody(req);
      const col = board.columns.find((c) => c.id === body.columnId);
      if (!col) return json(res, { error: "Column not found" }, 400);
      const task = {
        id: `task-${uid()}`,
        title: body.title || "New Task",
        description: body.description || "",
        color: body.color || 0,
        createdAt: new Date().toISOString(),
      };
      col.tasks.push(task);
      saveBoard(board);
      return json(res, task, 201);
    }

    // PUT /api/tasks/:id — update task
    if (resource === "tasks" && parts[2] && !parts[3] && req.method === "PUT") {
      const taskId = parts[2];
      const body = await parseBody(req);
      for (const col of board.columns) {
        const task = col.tasks.find((t) => t.id === taskId);
        if (task) {
          if (body.title !== undefined) task.title = body.title;
          if (body.description !== undefined) task.description = body.description;
          if (body.color !== undefined) task.color = body.color;
          saveBoard(board);
          return json(res, task);
        }
      }
      return notFound(res);
    }

    // PUT /api/tasks/:id/move — move task to another column
    if (resource === "tasks" && parts[2] && parts[3] === "move" && req.method === "PUT") {
      const taskId = parts[2];
      const body = await parseBody(req);
      const targetCol = board.columns.find((c) => c.id === body.targetColumnId);
      if (!targetCol) return json(res, { error: "Target column not found" }, 400);

      for (const col of board.columns) {
        const idx = col.tasks.findIndex((t) => t.id === taskId);
        if (idx !== -1) {
          const [task] = col.tasks.splice(idx, 1);
          task.movedAt = new Date().toISOString();
          targetCol.tasks.push(task);
          saveBoard(board);
          return json(res, { ...task, columnId: targetCol.id });
        }
      }
      return notFound(res);
    }

    // DELETE /api/tasks/:id — delete task
    if (resource === "tasks" && parts[2] && req.method === "DELETE") {
      const taskId = parts[2];
      for (const col of board.columns) {
        const idx = col.tasks.findIndex((t) => t.id === taskId);
        if (idx !== -1) {
          col.tasks.splice(idx, 1);
          saveBoard(board);
          return json(res, { deleted: true });
        }
      }
      return notFound(res);
    }

    // GET /api/initiatives
    if (resource === "initiatives" && req.method === "GET") {
      return json(res, board.initiatives || []);
    }

    // POST /api/initiatives
    if (resource === "initiatives" && req.method === "POST") {
      const body = await parseBody(req);
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
      saveBoard(board);
      return json(res, initiative, 201);
    }

    // GET /api/stats — board statistics
    if (resource === "stats" && req.method === "GET") {
      const stats = {};
      for (const col of board.columns) {
        stats[col.title] = col.tasks.length;
      }
      stats.total = board.columns.reduce((sum, col) => sum + col.tasks.length, 0);
      stats.initiatives = (board.initiatives || []).length;
      return json(res, stats);
    }

    // GET /api/tasks/recent — last 3 completed tasks (for dashboard)
    if (resource === "tasks" && url.pathname === "/api/tasks/recent" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit")) || 3;
      // Find "Done" or similar completed column
      const doneCol = board.columns.find(c => 
        c.title.toLowerCase().includes("done") || 
        c.title.toLowerCase().includes("review") ||
        c.title.toLowerCase() === "done"
      );
      if (doneCol) {
        const tasks = doneCol.tasks.slice(-limit).reverse();
        const result = tasks.map(task => ({
          ...task,
          columnId: doneCol.id,
          columnTitle: doneCol.title,
          // Extract agent from description if present
          agent: extractAgentFromDescription(task.description),
        }));
        return json(res, result);
      }
      return json(res, []);
    }

    return notFound(res);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Kanban API running on http://127.0.0.1:${PORT}`);
  // Initialize data file if it doesn't exist
  if (!fs.existsSync(DATA_FILE)) {
    saveBoard(DEFAULT_BOARD);
    console.log(`Created ${DATA_FILE} with default board`);
  }
});
