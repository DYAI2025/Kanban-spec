# Kanban Spec Framework

A full-stack Kanban board with AI-powered spec generation and multi-agent task execution. The board runs as a Vercel serverless API (Upstash Redis storage) with local companion services for LLM-driven automation.

## Architecture

```
                        ┌──────────────────────┐
                        │   Vercel Serverless   │
                        │   API + Upstash Redis │
                        └──────┬───────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────▼──────┐  ┌─────▼──────┐  ┌──────▼──────┐
       │  index.html  │  │ Spec Server│  │ Task Runner │
       │  (Frontend)  │  │ :3002      │  │ :3004       │
       └─────────────┘  └────────────┘  └──────┬──────┘
                                                │
                                    ┌───────────┼───────────┐
                                    │           │           │
                              ┌─────▼──┐  ┌────▼───┐  ┌───▼────┐
                              │ Claude │  │ Gemini │  │ Others │
                              │  CLI   │  │  CLI   │  │  ...   │
                              └────────┘  └────────┘  └────────┘
```

### Components

| Component | Description |
|-----------|-------------|
| **Vercel API** (`api/`) | Serverless CRUD endpoints for board, tasks, columns, backlog, and initiatives. Backed by Upstash Redis. |
| **Frontend** (`index.html`) | Single-file Kanban board UI with drag-and-drop, dark mode, backlog management, and spec generation triggers. |
| **Spec Server** (`spec-server.js`) | Polls backlog for projects needing specs. Calls Gemini or OpenRouter to generate structured specs + task lists. |
| **Task Runner** (`task-runner.js`) | Polls the "Queue" column, routes tasks to CLI agents by keyword matching, collects results, and moves tasks through the workflow. |
| **API Server** (`api-server.js`) | Optional local JSON-file API server (alternative to Vercel for offline/dev use). |
| **Server** (`server.js`) | Simple static file server + local API (alternative to Vercel). |

## Quick Start

### 1. Deploy the API to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Set environment variables on Vercel
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel env add KANBAN_API_TOKEN

# Deploy
vercel --prod
```

### 2. Configure environment

```bash
cp .env.example .env.local
# Edit .env.local with your values
```

### 3. Run companion services

```bash
# Spec Server — generates project specs via LLM
node spec-server.js

# Task Runner — dispatches board tasks to CLI agents
node task-runner.js
```

### 4. Local development (without Vercel)

```bash
# Run the local API server instead
node api-server.js    # API on :3002
node server.js        # Static files + API on :3000
```

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `UPSTASH_REDIS_REST_URL` | Vercel API | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel API | Upstash Redis auth token |
| `KANBAN_API_TOKEN` | Vercel API, Task Runner, Spec Server | Bearer token for API authentication |
| `KANBAN_API_URL` | Task Runner, Spec Server | Base URL of the deployed Kanban API |
| `GEMINI_API_KEY` | Spec Server | Google Gemini API key (primary LLM) |
| `OPENROUTER_API_KEY` | Spec Server | OpenRouter API key (fallback LLM) |

## Agent Configuration

The Task Runner routes tasks to CLI agents defined in `agents.json`. Each agent has:

```json
{
  "id": "claude",
  "name": "Claude Sonnet",
  "type": "cli",
  "cmd": "claude",
  "args": ["-p", "{prompt}", "--model", "claude-sonnet-4-5-20250929"],
  "keywords": ["implement", "code", "test", "fix"],
  "ramMB": 450,
  "enabled": true
}
```

| Field | Description |
|-------|-------------|
| `cmd` | CLI command to execute (must be in PATH) |
| `args` | Arguments — `{prompt}` and `{timestamp}` are replaced at runtime |
| `keywords` | Task title/description keywords that route to this agent |
| `ramMB` | Minimum free RAM required before spawning |
| `default` | If `true`, used when no keyword matches |
| `enabled` | Set `false` to disable without removing |
| `note` | Optional note explaining why agent is disabled |

### Task Workflow

```
Backlog → [Spec Server generates spec] → Queue → [Task Runner picks up]
→ Agent WIP → [CLI agent works] → Review (or retry on failure)
```

- Max 3 retry attempts per task
- Agent timeout: 10 minutes
- RAM check before each spawn
- Results stored in `results/<taskId>/`
- Reload agents config at runtime: `kill -HUP <pid>`

## API Endpoints (Vercel)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/board` | Full board state |
| POST | `/api/board` | Save full board |
| GET | `/api/tasks` | All tasks (flat) |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task |
| PUT | `/api/tasks/:id/move` | Move task to column |
| DELETE | `/api/tasks/:id` | Delete task |
| GET | `/api/columns` | All columns |
| POST | `/api/columns` | Create column |
| GET | `/api/backlog` | All backlog projects |
| PUT | `/api/backlog/:id` | Update backlog project |
| GET | `/api/initiatives` | All initiatives |
| POST | `/api/initiatives` | Create initiative |
| GET | `/api/stats` | Board statistics |
| GET | `/api/metrics` | System metrics |

All endpoints require `Authorization: Bearer <KANBAN_API_TOKEN>` header.

## License

MIT
