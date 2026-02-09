#!/usr/bin/env node

/**
 * Task Runner — Multi-Agent Task Orchestrator for the Kanban Board.
 *
 * Polls the "Queue" column for tasks, routes them to the best CLI agent
 * (Claude Code, Gemini CLI, OpenClaw), spawns them as child processes,
 * collects results, and moves tasks through the workflow.
 *
 * Workflow: Queue → Agent WIP → Review (or back to Queue on failure)
 *
 * Port: 3004 (health check)
 * Poll interval: 15 seconds
 * Max concurrent agents: 1 (RAM-limited)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ── Config ──────────────────────────────────────────────────
const PORT = 3004;
const KANBAN_API =
  process.env.KANBAN_API_URL || "https://your-kanban.vercel.app";
const KANBAN_TOKEN = process.env.KANBAN_API_TOKEN || "";
const POLL_INTERVAL = 15_000;
const MAX_CONCURRENT = 1;
const MIN_FREE_MB = 400;
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 3;
const MAX_STDOUT = 10 * 1024 * 1024; // 10MB buffer limit

const WORKSPACES_DIR = path.join(__dirname, "workspaces");
const RESULTS_DIR = path.join(__dirname, "results");
const AGENTS_CONFIG_PATH = path.join(__dirname, "agents.json");

// ── State ───────────────────────────────────────────────────
const activeAgents = new Map(); // taskId → { agent, process, startedAt }
let completedCount = 0;
let lastPollError = null;
let agentsConfig = []; // Loaded from agents.json

// Column IDs cache (resolved at startup)
let colIds = { queue: null, wip: null, review: null };

// ── Kanban API helpers ──────────────────────────────────────

async function kanbanGet(urlPath) {
  const headers = { "Content-Type": "application/json" };
  if (KANBAN_TOKEN) headers["Authorization"] = `Bearer ${KANBAN_TOKEN}`;
  const resp = await fetch(`${KANBAN_API}${urlPath}`, { headers });
  if (!resp.ok) throw new Error(`Kanban GET ${urlPath}: ${resp.status}`);
  return resp.json();
}

async function kanbanPut(urlPath, data) {
  const headers = { "Content-Type": "application/json" };
  if (KANBAN_TOKEN) headers["Authorization"] = `Bearer ${KANBAN_TOKEN}`;
  const resp = await fetch(`${KANBAN_API}${urlPath}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Kanban PUT ${urlPath}: ${resp.status}`);
  return resp.json();
}

async function kanbanPost(urlPath, data) {
  const headers = { "Content-Type": "application/json" };
  if (KANBAN_TOKEN) headers["Authorization"] = `Bearer ${KANBAN_TOKEN}`;
  const resp = await fetch(`${KANBAN_API}${urlPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Kanban POST ${urlPath}: ${resp.status}`);
  return resp.json();
}

async function moveTask(taskId, targetColId) {
  return kanbanPut(`/api/tasks/${taskId}/move`, { targetColumnId: targetColId });
}

async function updateTask(taskId, data) {
  return kanbanPut(`/api/tasks/${taskId}`, data);
}

// ── Agent Meta helpers ──────────────────────────────────────

const META_SEPARATOR = "\n\n---agent-meta---\n";

function parseAgentMeta(description) {
  if (!description) return null;
  const idx = description.indexOf("---agent-meta---");
  if (idx === -1) return null;
  const jsonStr = description.slice(idx + "---agent-meta---".length).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function getCleanDescription(description) {
  if (!description) return "";
  const idx = description.indexOf("---agent-meta---");
  if (idx === -1) return description;
  return description.slice(0, idx).trim();
}

function setAgentMeta(description, meta) {
  const clean = getCleanDescription(description);
  return clean + META_SEPARATOR + JSON.stringify(meta);
}

// ── Agents Config ───────────────────────────────────────────

function loadAgentsConfig() {
  try {
    const raw = fs.readFileSync(AGENTS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    agentsConfig = parsed.agents || [];
    console.log(`Loaded ${agentsConfig.length} agents from agents.json (${agentsConfig.filter(a => a.enabled).length} enabled)`);
  } catch (err) {
    console.error(`Failed to load agents.json: ${err.message}`);
    if (agentsConfig.length > 0) {
      console.log("Keeping previous agents config.");
    }
  }
}

// Reload config on SIGHUP
process.on("SIGHUP", () => {
  console.log("SIGHUP received — reloading agents.json...");
  loadAgentsConfig();
});

// ── Agent Routing ───────────────────────────────────────────

function routeToAgent(task) {
  // Explicit agent in meta overrides routing
  const meta = parseAgentMeta(task.description || task.desc);
  if (meta && meta.agent) return meta.agent;

  const text = ((task.title || "") + " " + getCleanDescription(task.description || task.desc)).toLowerCase();

  const enabledAgents = agentsConfig.filter(a => a.enabled && a.keywords && a.keywords.length > 0);

  // Score each agent by keyword matches
  const scores = {};
  for (const agent of enabledAgents) {
    let score = 0;
    for (const kw of agent.keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > 0) scores[agent.id] = score;
  }

  // Find best match
  const entries = Object.entries(scores);
  if (entries.length === 0) {
    // Default: first agent with default flag, or first enabled agent
    const defaultAgent = agentsConfig.find(a => a.enabled && a.default);
    return defaultAgent ? defaultAgent.id : (agentsConfig.find(a => a.enabled) || { id: "gemini" }).id;
  }

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

// ── RAM Check ───────────────────────────────────────────────

function getFreeMB() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const available = meminfo.match(/MemAvailable:\s+(\d+)/);
    if (available) return Math.floor(parseInt(available[1]) / 1024);
  } catch {}
  return 9999; // Assume OK if we can't read
}

// ── Prompt Builder ──────────────────────────────────────────

function buildPrompt(task, relatedTasks) {
  const cleanDesc = getCleanDescription(task.description || task.desc);
  const relatedSection =
    relatedTasks.length > 0
      ? `\n## RELATED TASKS (nur zur Info)\n${relatedTasks.map((t) => `- ${t.title}`).join("\n")}`
      : "";

  return `## TASK
${task.title}

## DESCRIPTION
${cleanDesc || "(keine Beschreibung)"}

## CONSTRAINTS
- Erstelle am Ende eine RESULT.md mit einer Zusammenfassung deiner Arbeit
- Beschreibe was du gemacht hast, welche Dateien du erstellt/geändert hast
- Wenn du Code committet hast: Nenne den GitHub-Link zum Commit oder PR
- Wenn du Dokumente erstellt hast: Nenne den Dateipfad
- Bei Fehlern: Beschreibe was schiefging und mögliche Lösungen
${relatedSection}`;
}

// ── Agent Spawner ───────────────────────────────────────────

function spawnAgent(agent, prompt, workDir, taskId) {
  const agentDef = agentsConfig.find(a => a.id === agent);
  if (!agentDef) {
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: `Unknown agent: ${agent} (not found in agents.json)`,
      exitCode: 1,
      durationMs: 0,
    });
  }

  if (!agentDef.enabled) {
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: `Agent ${agent} is disabled: ${agentDef.note || "no reason given"}`,
      exitCode: 1,
      durationMs: 0,
    });
  }

  const cmd = agentDef.cmd;
  const timestamp = String(Date.now());
  const args = agentDef.args.map(a =>
    a.replaceAll("{prompt}", prompt).replaceAll("{timestamp}", timestamp)
  );

  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let killed = false;

  const proc = spawn(cmd, args, {
    cwd: workDir,
    env: { ...process.env, HOME: process.env.HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Store process ref for tracking and graceful shutdown
  if (taskId && activeAgents.has(taskId)) {
    const info = activeAgents.get(taskId);
    info.process = proc;
    info.pid = proc.pid;
  }

  const timeout = setTimeout(() => {
    killed = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 5000);
  }, AGENT_TIMEOUT_MS);

  proc.stdout.on("data", (chunk) => {
    if (stdout.length < MAX_STDOUT) stdout += chunk.toString();
  });

  proc.stderr.on("data", (chunk) => {
    if (stderr.length < MAX_STDOUT) stderr += chunk.toString();
  });

  return new Promise((resolve) => {
    proc.on("close", (code) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
      resolve({
        success: code === 0 && !killed,
        stdout,
        stderr,
        exitCode: code,
        durationMs,
        timedOut: killed,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        stdout,
        stderr: err.message,
        exitCode: -1,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ── Result Collector ────────────────────────────────────────

function collectResult(taskId, workDir, agentResult) {
  const resultDir = path.join(RESULTS_DIR, String(taskId));
  fs.mkdirSync(resultDir, { recursive: true });

  // Save agent log
  fs.writeFileSync(
    path.join(resultDir, "agent.log"),
    `--- STDOUT ---\n${agentResult.stdout}\n\n--- STDERR ---\n${agentResult.stderr}`,
    "utf8"
  );

  // Copy RESULT.md if agent created it
  const resultMd = path.join(workDir, "RESULT.md");
  let summary = "";
  if (fs.existsSync(resultMd)) {
    const content = fs.readFileSync(resultMd, "utf8");
    fs.copyFileSync(resultMd, path.join(resultDir, "RESULT.md"));
    summary = content.length > 500 ? content.slice(0, 500) + "..." : content;
  } else {
    // Generate summary from stdout
    const lines = agentResult.stdout.trim().split("\n");
    summary = lines.slice(-20).join("\n");
    if (summary.length > 500) summary = summary.slice(-500);
    fs.writeFileSync(
      path.join(resultDir, "RESULT.md"),
      `# Auto-generated Result\n\n(Agent hat keine RESULT.md erstellt)\n\n## Agent Output (letzte Zeilen)\n\n${summary}`,
      "utf8"
    );
  }

  // Save metadata
  fs.writeFileSync(
    path.join(resultDir, "meta.json"),
    JSON.stringify(
      {
        taskId,
        exitCode: agentResult.exitCode,
        durationMs: agentResult.durationMs,
        timedOut: agentResult.timedOut || false,
        success: agentResult.success,
        completedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  return summary;
}

// ── Ensure Columns ──────────────────────────────────────────

async function ensureColumns() {
  const boardData = await kanbanGet("/api/board");
  const columns = boardData.columns || [];

  const needed = [
    { key: "queue", title: "Queue" },
    { key: "wip", title: "Agent WIP" },
    { key: "review", title: "Review" },
  ];

  for (const { key, title } of needed) {
    const existing = columns.find(
      (c) => c.title.toLowerCase() === title.toLowerCase()
    );
    if (existing) {
      colIds[key] = existing.id;
    } else {
      // Add column to board
      const newCol = { id: Date.now() + Math.floor(Math.random() * 1000), title, tasks: [] };

      // Find insertion point: Queue before Agent WIP before Review, all before Done
      const doneIdx = columns.findIndex(
        (c) => c.title.toLowerCase() === "done"
      );
      if (key === "queue") {
        const wipIdx = columns.findIndex(
          (c) => c.title.toLowerCase() === "agent wip"
        );
        if (wipIdx >= 0) columns.splice(wipIdx, 0, newCol);
        else if (doneIdx >= 0) columns.splice(doneIdx, 0, newCol);
        else columns.push(newCol);
      } else if (key === "wip") {
        const reviewIdx = columns.findIndex(
          (c) => c.title.toLowerCase() === "review"
        );
        if (reviewIdx >= 0) columns.splice(reviewIdx, 0, newCol);
        else if (doneIdx >= 0) columns.splice(doneIdx, 0, newCol);
        else columns.push(newCol);
      } else {
        if (doneIdx >= 0) columns.splice(doneIdx, 0, newCol);
        else columns.push(newCol);
      }

      colIds[key] = newCol.id;
      console.log(`  Created column: ${title} (id: ${newCol.id})`);
    }
  }

  // Save updated board with new columns (board endpoint uses POST)
  boardData.columns = columns;
  await kanbanPost("/api/board", boardData);

  console.log(
    `Column IDs — Queue: ${colIds.queue}, WIP: ${colIds.wip}, Review: ${colIds.review}`
  );
}

// ── Process a Single Task ───────────────────────────────────

async function processTask(task, boardData) {
  const taskId = task.id;
  const agent = routeToAgent(task);
  const ts = () => new Date().toISOString();

  console.log(`[${ts()}] Processing task ${taskId}: "${task.title}" → ${agent}`);

  // Check agent-specific RAM requirement
  const agentDef = agentsConfig.find(a => a.id === agent);
  const requiredMB = (agentDef && agentDef.ramMB) || MIN_FREE_MB;
  const freeMB = getFreeMB();
  if (freeMB < requiredMB) {
    console.log(`[${ts()}] Skipping task ${taskId}: ${freeMB}MB free, agent ${agent} needs ${requiredMB}MB`);
    return;
  }

  // Create workspace
  const workDir = path.join(WORKSPACES_DIR, String(taskId));
  fs.mkdirSync(workDir, { recursive: true });

  // Update meta: running
  const meta = parseAgentMeta(task.description || task.desc) || {
    agent: null,
    status: "queued",
    attempts: 0,
    startedAt: null,
    resultPath: null,
    lastError: null,
  };
  meta.agent = agent;
  meta.status = "running";
  meta.attempts = (meta.attempts || 0) + 1;
  meta.startedAt = new Date().toISOString();

  try {
    await updateTask(taskId, { description: setAgentMeta(task.description || task.desc, meta) });
  } catch (e) {
    console.log(`  Warning: could not update task meta: ${e.message}`);
  }

  // Move to WIP
  try {
    await moveTask(taskId, colIds.wip);
  } catch (e) {
    console.log(`  Warning: could not move to WIP: ${e.message}`);
  }

  // Track active agent
  activeAgents.set(taskId, { agent, startedAt: Date.now() });

  // Get related tasks for context
  const allTasks = (boardData.columns || []).flatMap((c) => c.tasks || []);
  const relatedTasks = allTasks
    .filter((t) => t.id !== taskId && t.color === task.color && task.color)
    .slice(0, 5);

  // Build prompt and spawn
  const prompt = buildPrompt(task, relatedTasks);
  const result = await spawnAgent(agent, prompt, workDir, taskId);

  activeAgents.delete(taskId);

  console.log(
    `[${ts()}] Agent ${agent} finished task ${taskId}: exit=${result.exitCode} duration=${Math.round(result.durationMs / 1000)}s${result.timedOut ? " (TIMEOUT)" : ""}`
  );

  // Collect result
  const summary = collectResult(taskId, workDir, result);
  const resultPath = path.join(RESULTS_DIR, String(taskId));

  if (result.success) {
    // Success → move to Review
    meta.status = "review";
    meta.resultPath = resultPath;
    meta.lastError = null;
    meta.resultSummary = summary.slice(0, 2000);

    const updatedDesc = setAgentMeta(task.description || task.desc, meta);
    try {
      await updateTask(taskId, { description: updatedDesc });
      await moveTask(taskId, colIds.review);
    } catch (e) {
      console.log(`  Warning: could not move to Review: ${e.message}`);
    }

    completedCount++;
    console.log(
      `[${ts()}] Task ${taskId} → Review (${summary.slice(0, 100)}...)`
    );
  } else {
    // Failure
    const errorMsg = result.timedOut
      ? "Timeout (10min)"
      : `Exit ${result.exitCode}: ${(result.stderr || "").slice(0, 200)}`;

    meta.status = "failed";
    meta.resultPath = resultPath;
    meta.lastError = errorMsg;
    meta.resultSummary = (summary || errorMsg).slice(0, 2000);

    if (meta.attempts < MAX_ATTEMPTS) {
      // Retry: move back to Queue
      meta.status = "queued";
      const updatedDesc = setAgentMeta(task.description || task.desc, meta);
      try {
        await updateTask(taskId, { description: updatedDesc });
        await moveTask(taskId, colIds.queue);
      } catch (e) {
        console.log(`  Warning: could not move back to Queue: ${e.message}`);
      }
      console.log(
        `[${ts()}] Task ${taskId} failed (attempt ${meta.attempts}/${MAX_ATTEMPTS}), back to Queue: ${errorMsg}`
      );
    } else {
      // Max retries → move to Review with failure status
      const updatedDesc = setAgentMeta(task.description || task.desc, meta);
      try {
        await updateTask(taskId, { description: updatedDesc });
        await moveTask(taskId, colIds.review);
      } catch (e) {
        console.log(
          `  Warning: could not move failed task to Review: ${e.message}`
        );
      }
      console.log(
        `[${ts()}] Task ${taskId} failed permanently after ${MAX_ATTEMPTS} attempts: ${errorMsg}`
      );
    }
  }
}

// ── Poll Loop ───────────────────────────────────────────────

async function poll() {
  try {
    // Skip if at capacity
    if (activeAgents.size >= MAX_CONCURRENT) return;

    // Check RAM
    const freeMB = getFreeMB();
    if (freeMB < MIN_FREE_MB) {
      console.log(`  Skipping poll: only ${freeMB}MB free (need ${MIN_FREE_MB}MB)`);
      return;
    }

    // Fetch board
    const boardData = await kanbanGet("/api/board");
    const columns = boardData.columns || [];

    // Refresh column IDs in case they changed
    for (const col of columns) {
      const lower = col.title.toLowerCase();
      if (lower === "queue") colIds.queue = col.id;
      else if (lower === "agent wip") colIds.wip = col.id;
      else if (lower === "review") colIds.review = col.id;
    }

    if (!colIds.queue) {
      lastPollError = "Queue column not found";
      return;
    }

    // Find queue column
    const queueCol = columns.find((c) => c.id === colIds.queue);
    if (!queueCol || !queueCol.tasks || queueCol.tasks.length === 0) {
      lastPollError = null;
      return;
    }

    // Pick first task (FIFO)
    const task = queueCol.tasks[0];

    // Skip tasks that are already being processed
    if (activeAgents.has(task.id)) return;

    // Check if meta says it's waiting for retry cooldown
    const meta = parseAgentMeta(task.description || task.desc);
    if (meta && meta.status === "running") {
      // Task claims to be running but isn't in our activeAgents — stale state
      // Reset it
      meta.status = "queued";
      try {
        await updateTask(task.id, {
          description: setAgentMeta(task.description || task.desc, meta),
        });
      } catch {}
    }

    lastPollError = null;
    processTask(task, boardData).catch(err => {
      console.error(`Unhandled error processing task ${task.id}: ${err.message}`);
      activeAgents.delete(task.id);
    });
  } catch (err) {
    lastPollError = err.message;
  }
}

// ── Export / Backup ──────────────────────────────────────────

const EXPORTS_DIR = path.join(__dirname, "exports");

async function exportBackup() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const exportFile = path.join(EXPORTS_DIR, `backup-${ts}.json`);

  // Collect board state
  const boardData = await kanbanGet("/api/board");

  // Collect all results metadata
  const resultEntries = [];
  if (fs.existsSync(RESULTS_DIR)) {
    for (const dir of fs.readdirSync(RESULTS_DIR)) {
      const metaPath = path.join(RESULTS_DIR, dir, "meta.json");
      const resultPath = path.join(RESULTS_DIR, dir, "RESULT.md");
      const entry = { taskId: dir };
      if (fs.existsSync(metaPath)) entry.meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (fs.existsSync(resultPath)) entry.result = fs.readFileSync(resultPath, "utf8");
      resultEntries.push(entry);
    }
  }

  const backup = {
    exportedAt: new Date().toISOString(),
    board: boardData,
    results: resultEntries,
    stats: { completed: completedCount, uptime: Math.floor(process.uptime()) },
  };

  fs.writeFileSync(exportFile, JSON.stringify(backup, null, 2), "utf8");
  return { file: exportFile, tasks: (boardData.columns || []).reduce((n, c) => n + c.tasks.length, 0), results: resultEntries.length };
}

// ── Health Endpoint ─────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers for frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/agents — agent registry for frontend
  if (url.pathname === "/api/agents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents: agentsConfig }));
    return;
  }

  // GET /export — create backup
  if (url.pathname === "/export") {
    try {
      const info = await exportBackup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...info }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET / — health
  const running = {};
  for (const [taskId, info] of activeAgents) {
    running[taskId] = {
      agent: info.agent,
      pid: info.pid || null,
      runtimeMs: Date.now() - info.startedAt,
    };
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      service: "task-runner",
      maxConcurrent: MAX_CONCURRENT,
      activeAgents: running,
      agentsLoaded: agentsConfig.length,
      agentsEnabled: agentsConfig.filter(a => a.enabled).length,
      completed: completedCount,
      freeMB: getFreeMB(),
      columns: colIds,
      lastPollError,
      uptime: Math.floor(process.uptime()),
    })
  );
});

// ── Startup ─────────────────────────────────────────────────

async function start() {
  // Ensure directories
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Load agents config
  loadAgentsConfig();

  console.log("Task Runner starting...");
  console.log(`Kanban API: ${KANBAN_API}`);
  console.log(`Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`Agent timeout: ${AGENT_TIMEOUT_MS / 1000}s`);
  console.log(`Poll interval: ${POLL_INTERVAL / 1000}s`);

  // Ensure columns exist
  try {
    await ensureColumns();
  } catch (err) {
    console.error(`Failed to ensure columns: ${err.message}`);
    console.log("Will retry on next poll cycle...");
  }

  // Start health server
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Health endpoint: http://127.0.0.1:${PORT}`);
    console.log("Polling started...");
  });

  // Start poll loop
  const pollTimer = setInterval(poll, POLL_INTERVAL);
  poll();

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    clearInterval(pollTimer);
    for (const [taskId, info] of activeAgents) {
      if (info.process) {
        console.log(`  Killing agent for task ${taskId} (pid ${info.pid})`);
        try { info.process.kill("SIGTERM"); } catch {}
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
