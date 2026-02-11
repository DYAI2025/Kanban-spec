#!/usr/bin/env node

/**
 * Spec-Server — Local VPS server for AI-powered spec generation.
 *
 * Polls the Kanban API for backlog projects with specStatus "generating"
 * and calls LLM APIs directly to produce specs + task lists.
 *
 * Model chain: Gemini 2.5 Flash (free) → OpenRouter Qwen3-235B (fallback)
 *
 * Port: 3002 (health check only)
 * Poll interval: 10 seconds
 */

const http = require("http");
const fs = require("fs");

const PORT = 3002;
const KANBAN_API = process.env.KANBAN_API_URL || "https://kanban-jet-seven.vercel.app";
const KANBAN_TOKEN = process.env.KANBAN_API_TOKEN || "";
const POLL_INTERVAL = 10_000;

// API Keys
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

// Track which projects are currently being processed (id → start timestamp)
const processing = new Map();
const MAX_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes max per spec

// Track which provider was used last (for health endpoint)
let lastProvider = null;
let lastTokens = null;

// ── Kanban API helpers ──────────────────────────────────────────

async function kanbanFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (KANBAN_TOKEN) headers["Authorization"] = `Bearer ${KANBAN_TOKEN}`;
  const resp = await fetch(`${KANBAN_API}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  // On 401, retry without auth header (token mismatch with Vercel env)
  if (resp.status === 401 && KANBAN_TOKEN) {
    console.log(`  → 401 with token, retrying without auth header`);
    const noAuthHeaders = { "Content-Type": "application/json" };
    const resp2 = await fetch(`${KANBAN_API}${path}`, {
      ...options,
      headers: noAuthHeaders,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp2.ok) throw new Error(`Kanban API ${path}: ${resp2.status} (no-auth retry)`);
    return resp2.json();
  }
  if (!resp.ok) throw new Error(`Kanban API ${path}: ${resp.status}`);
  return resp.json();
}

async function kanbanGet(path) {
  return kanbanFetch(path);
}

async function kanbanPut(path, data) {
  return kanbanFetch(path, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ── GitHub & Document Fetching ──────────────────────────────────

function parseGitHubUrl(url) {
  if (!url) return null;
  // Handle repos like "Bazodiac.com.git", "FlashDoc.git", "repo-name"
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function fetchGitHubContext(githubLink) {
  const gh = parseGitHubUrl(githubLink);
  if (!gh) return "";

  const parts = [];

  // Fetch README
  for (const branch of ["main", "master"]) {
    try {
      const resp = await fetch(
        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}/README.md`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (resp.ok) {
        let readme = await resp.text();
        if (readme.length > 2500) readme = readme.slice(0, 2500) + "\n…(gekürzt)";
        parts.push(`### README.md\n${readme}`);
        break;
      }
    } catch (e) { /* try next branch */ }
  }

  // Fetch file tree
  for (const branch of ["main", "master"]) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${gh.owner}/${gh.repo}/git/trees/${branch}?recursive=1`,
        { headers: { "User-Agent": "spec-server" }, signal: AbortSignal.timeout(10_000) }
      );
      if (resp.ok) {
        const data = await resp.json();
        const files = (data.tree || [])
          .filter(f => f.type === "blob")
          .map(f => f.path);
        if (files.length > 0) {
          const tree = files.length > 40
            ? files.slice(0, 40).join("\n") + `\n…(${files.length - 40} weitere Dateien)`
            : files.join("\n");
          parts.push(`### Dateistruktur (${files.length} Dateien)\n${tree}`);
        }
        break;
      }
    } catch (e) { /* try next branch */ }
  }

  // Fetch package.json for tech stack info
  for (const branch of ["main", "master"]) {
    try {
      const resp = await fetch(
        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}/package.json`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (resp.ok) {
        const pkg = await resp.json();
        const deps = Object.keys(pkg.dependencies || {}).join(", ");
        const devDeps = Object.keys(pkg.devDependencies || {}).join(", ");
        let pkgInfo = `### package.json\n- Name: ${pkg.name || "?"}\n- Version: ${pkg.version || "?"}`;
        if (deps) pkgInfo += `\n- Dependencies: ${deps}`;
        if (devDeps) pkgInfo += `\n- DevDependencies: ${devDeps}`;
        parts.push(pkgInfo);
        break;
      }
    } catch (e) { /* no package.json */ }
  }

  if (parts.length > 0) {
    console.log(`  → GitHub: fetched ${parts.length} sections for ${gh.owner}/${gh.repo}`);
  } else {
    console.log(`  → GitHub: no content found for ${gh.owner}/${gh.repo}`);
  }
  return parts.length > 0
    ? `\n## GitHub Repository Analyse\n\n${parts.join("\n\n")}`
    : "";
}

async function fetchDocuments(documents) {
  if (!documents || documents.length === 0) return "";
  const parts = [];

  for (const doc of documents.slice(0, 5)) {
    // If content is stored directly (file upload), use it
    if (doc.content) {
      let text = doc.content;
      if (text.length > 3000) text = text.slice(0, 3000) + "\n…(gekürzt)";
      parts.push(`### ${doc.name}\n${text}`);
      continue;
    }

    // Otherwise fetch from URL
    if (!doc.url) continue;
    try {
      const resp = await fetch(doc.url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "spec-server" },
      });
      if (!resp.ok) {
        parts.push(`### ${doc.name}\n(Konnte nicht geladen werden: HTTP ${resp.status})`);
        continue;
      }
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("pdf")) {
        parts.push(`### ${doc.name}\n(PDF-Dokument — URL: ${doc.url})`);
        continue;
      }
      let text = await resp.text();
      // Strip HTML tags for HTML documents
      if (contentType.includes("html")) {
        text = text.replace(/<script[\s\S]*?<\/script>/gi, "")
                   .replace(/<style[\s\S]*?<\/style>/gi, "")
                   .replace(/<[^>]+>/g, " ")
                   .replace(/\s{2,}/g, " ")
                   .trim();
      }
      if (text.length > 3000) text = text.slice(0, 3000) + "\n…(gekürzt)";
      parts.push(`### ${doc.name}\n${text}`);
    } catch (e) {
      parts.push(`### ${doc.name}\n(Fehler beim Laden: ${e.message})`);
    }
  }

  return parts.length > 0
    ? `\n## Angehängte Dokumente\n\n${parts.join("\n\n")}`
    : "";
}

// ── Prompt ──────────────────────────────────────────────────────

async function buildPrompt(project) {
  // Fetch GitHub and document context in parallel
  const [githubContext, docContext] = await Promise.all([
    fetchGitHubContext(project.githubLink).catch(e => {
      console.log(`  → GitHub fetch failed: ${e.message}`);
      return "";
    }),
    fetchDocuments(project.documents).catch(e => {
      console.log(`  → Document fetch failed: ${e.message}`);
      return "";
    }),
  ]);

  const contextInfo = githubContext || docContext
    ? `\n# Recherchierte Kontext-Informationen\n${githubContext}${docContext}`
    : "";

  return `Du bist ein erfahrener Product Manager und Solutions Architect.

Analysiere folgendes Projekt und erstelle eine strukturierte Spezifikation.
Nutze die recherchierten Informationen aus dem Repository und den Dokumenten.

## Projekt: ${project.title}

**Beschreibung:** ${project.description}

**GitHub:** ${project.githubLink || "nicht angegeben"}
${contextInfo}

## Aufgabe

Erstelle basierend auf den obigen Informationen:
1. Eine detaillierte Spezifikation als Markdown mit: Projektübersicht, Ziele, Features, Architektur, Tech-Stack, Risiken
2. Konkrete Aufgaben für die Umsetzung (5-15 Tasks, priorisiert)

WICHTIG: Antworte mit einem JSON-Objekt mit ZWEI separaten Keys:
- "spec": Ein Markdown-String mit der Spezifikation (OHNE die Tasks)
- "tasks": Ein Array von Objekten mit "title" und "details"

Die Tasks MÜSSEN im "tasks"-Array stehen, NICHT im "spec"-String.

Beispiel-Format:
{"spec": "# Projekt\\n\\n## Übersicht\\n...", "tasks": [{"title": "MVP implementieren", "details": "Beschreibung der Aufgabe"}]}

Kein Markdown-Codeblock drumherum, nur reines JSON.`;
}

// ── LLM Providers ───────────────────────────────────────────────

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (resp.status === 429) {
    const err = new Error("Gemini rate limited");
    err.rateLimited = true;
    throw err;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const tokens = data.usageMetadata;
  return { text, tokens, provider: "gemini-2.5-flash" };
}

async function callOpenRouter(prompt) {
  if (!OPENROUTER_KEY) throw new Error("OPENROUTER_API_KEY not set");

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen/qwen3-235b-a22b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenRouter API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage;
  return { text, tokens, provider: "qwen3-235b (OpenRouter)" };
}

// ── LLM call with fallback ──────────────────────────────────────

async function callLLM(prompt) {
  // Primary: Gemini 2.5 Flash
  if (GEMINI_KEY) {
    try {
      const result = await callGemini(prompt);
      console.log(`  → Gemini OK (${JSON.stringify(result.tokens)})`);
      return result;
    } catch (err) {
      if (err.rateLimited) {
        console.log(`  → Gemini rate limited, falling back to OpenRouter`);
      } else {
        console.log(`  → Gemini failed: ${err.message}, falling back to OpenRouter`);
      }
    }
  }

  // Fallback: OpenRouter Qwen3
  const result = await callOpenRouter(prompt);
  console.log(`  → OpenRouter Qwen3 OK (${JSON.stringify(result.tokens)})`);
  return result;
}

// ── JSON extraction ─────────────────────────────────────────────

function extractJSON(text) {
  // Clean up: remove markdown code fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  // Qwen3 sometimes wraps response in <think>...</think> tags
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  cleaned = cleaned.trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.spec !== undefined) {
      // If tasks is missing, default to empty array
      if (!parsed.tasks) {
        console.log(`  → JSON parsed but no "tasks" key, defaulting to empty array`);
        parsed.tasks = [];
      }
      return parsed;
    }
  } catch (e) { /* fall through */ }

  // Try extracting JSON object from text (with or without tasks key)
  const match = cleaned.match(/\{[\s\S]*"spec"[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.spec !== undefined) {
        if (!parsed.tasks) parsed.tasks = [];
        return parsed;
      }
    } catch (e) { /* fall through */ }
  }

  // Fallback: extract spec and tasks separately via regex
  // This handles cases where JSON has unescaped quotes in string values
  try {
    // Extract spec: everything between "spec": " and ", "tasks"
    const specMatch = cleaned.match(/"spec"\s*:\s*"([\s\S]*?)"\s*,\s*"tasks"/);
    // Extract tasks array
    const tasksMatch = cleaned.match(/"tasks"\s*:\s*(\[[\s\S]*\])\s*\}?\s*$/);

    if (specMatch && tasksMatch) {
      const spec = specMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      let tasks = [];
      try { tasks = JSON.parse(tasksMatch[1]); } catch (e) {
        // Try to extract individual tasks with regex
        const taskMatches = [...tasksMatch[1].matchAll(/"title"\s*:\s*"([^"]*?)"\s*,\s*"details"\s*:\s*"([^"]*?)"/g)];
        tasks = taskMatches.map(m => ({ title: m[1], details: m[2] }));
      }
      if (spec && tasks.length > 0) {
        console.log(`  → Used regex fallback extraction (${tasks.length} tasks)`);
        return { spec, tasks };
      }
    }
  } catch (e) { /* fall through */ }

  throw new Error("Could not extract spec JSON from LLM output");
}

// ── Spec generation ─────────────────────────────────────────────

async function generateSpec(project) {
  const projectId = project.id;
  if (processing.has(projectId)) return;
  processing.set(projectId, Date.now());

  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] Starting spec generation for: ${project.title} (${projectId})`);

  try {
    const prompt = await buildPrompt(project);
    const { text, tokens, provider } = await callLLM(prompt);
    lastProvider = provider;
    lastTokens = tokens;

    // Debug: save raw output on failure
    let result;
    try {
      result = extractJSON(text);
    } catch (parseErr) {
      fs.writeFileSync(`/tmp/spec-debug-${projectId}.txt`, text, "utf8");
      console.log(`  → Raw output saved to /tmp/spec-debug-${projectId}.txt (${text.length} chars)`);
      throw parseErr;
    }
    const spec = result.spec || "";
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];

    await kanbanPut(`/api/backlog/${projectId}`, {
      specStatus: "ready",
      spec: spec,
      specTasks: tasks,
    });

    console.log(`[${ts()}] Spec ready for ${project.title}: ${tasks.length} tasks [${provider}]`);
  } catch (err) {
    console.error(`[${ts()}] Spec generation failed for ${project.title}:`, err.message);
    await kanbanPut(`/api/backlog/${projectId}`, {
      specStatus: "error",
      spec: `Fehler bei Spec-Generierung: ${err.message}`,
    }).catch(() => {});
  } finally {
    processing.delete(projectId);
  }
}

// ── Polling ─────────────────────────────────────────────────────

async function pollBacklog() {
  // Clean up stuck projects (exceeded MAX_PROCESSING_MS)
  const now = Date.now();
  for (const [id, startTime] of processing) {
    if (now - startTime > MAX_PROCESSING_MS) {
      console.log(`[${new Date().toISOString()}] Clearing stuck project ${id} (running ${Math.round((now - startTime) / 1000)}s)`);
      processing.delete(id);
    }
  }

  try {
    const backlog = await kanbanGet("/api/backlog");
    const pending = backlog.filter(
      (p) => p.specStatus === "generating" && !processing.has(p.id)
    );
    for (const project of pending) {
      generateSpec(project); // fire and forget
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error: ${err.message}`);
  }
}

// ── HTTP health check server ────────────────────────────────────

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "spec-server",
    providers: {
      primary: GEMINI_KEY ? "gemini-2.5-flash" : "not configured",
      fallback: OPENROUTER_KEY ? "qwen3-235b (OpenRouter)" : "not configured",
    },
    lastProvider,
    lastTokens,
    processing: [...processing.keys()],
  }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Spec-Server running on http://127.0.0.1:${PORT}`);
  console.log(`Kanban API: ${KANBAN_API}`);
  console.log(`Primary: Gemini 2.5 Flash ${GEMINI_KEY ? "✓" : "✗ (no key)"}`);
  console.log(`Fallback: OpenRouter Qwen3 ${OPENROUTER_KEY ? "✓" : "✗ (no key)"}`);
  console.log(`Polling every ${POLL_INTERVAL / 1000}s`);

  setInterval(pollBacklog, POLL_INTERVAL);
  pollBacklog();
});
