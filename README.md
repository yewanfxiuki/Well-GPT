# NEXUS AI CODE — PHOENIX (Well-GPT foundation)

**Product:** NEXUS AI CODE · **Assistant identity:** Crouton (C-R-O-U-T-O-N) · **Assistant name** is configurable via `ASSISTANT_NAME`, independent of providers/models.

ChatGPT simplicity + OpenCode developer power. Android, PC/laptop, Web (responsive, PWA-ready).

## Shipped now (real, tested)
- **Identity:** NEXUS + Crouton name/personality in server config; stays consistent across model switches.
- **Reasoning:** Default/Low/Medium/High/Max → capability map (`THINK_VARIANT`), shown in picker; Max = deepest system prompt + most tokens. No fake chain-of-thought claims.
- **Marketplace:** `/api/v1/models` returns OpenCode $0 catalog + metadata (provider/free/coding/reasoning/context/rateLimit/lastVerified). UI filters All/Free/Coding/Reasoning. Crouton Alpha Free first. **Free is never unlimited** — quotas respected.
- **Chat:** streaming-style, markdown (safe), copy, edit-by-resend, sessions + search, attachments placeholder disabled honestly, preview for built HTML.
- **Workspace (agent foundation):** real isolated `workspace/` FS tools — `list/read/write` (auth + traversal-safe + 50KB cap) + `node --check` execution (no shell, 10s timeout). Artifact-free, audit-logged.
- **GitHub:** status + real repo list **only if** `GITHUB_TOKEN` set server-side (least-privilege PAT). Otherwise honest `connected:false`. OAuth stubs for GitHub/Google.
- **Usage:** `/api/v1/usage` (auth) + toggle to show/hide. No fake stats.
- **Owner:** `/control-center` (+ `/admin` alias) with server-side admin auth (httpOnly, rate-limited). Health/version/logs.
- **Security:** headers/CSP, validation, rate limits, session cookies, no secrets in browser/logs, no backdoors.
- **Cross-platform:** single responsive codebase, touch-friendly, dark NEXUS palette (#0D0F12…#8B9CFF) + light.

## Run
```bash
export ADMIN_PASSWORD=your-strong-password
node server.js
# Chat http://127.0.0.1:3000 · Control Center http://127.0.0.1:3000/control-center
```

## Env (server-only)
```bash
PORT=3000 APP_URL=http://127.0.0.1:3000 ASSISTANT_NAME=Crouton ADMIN_PASSWORD=...
OPENCODE_API_BASE= OPENCODE_API_KEY=   # optional true upstream (OpenAI-compat)
GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= # OAuth
GITHUB_TOKEN=                            # optional PAT for repo listing (server-only, scoped)
GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=
```

## API (versioned)
`GET /api/v1/health|models|usage|github/repos|projects/workspace/list|read` · `POST /api/v1/chat|projects/workspace/write|executions/check|auth/guest|auth/email`

## Roadmap (honest — not yet built)
TS/Fastify/Postgres/Redis, Monaco/xterm, Tauri/Capacitor packaging, background workers, CI/CD workflows, full shell terminal (needs container isolation + approval flow). Each will land phase-by-phase with tests — no mock features advertised.
