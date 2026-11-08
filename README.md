# Well-GPT (Crouton AI) — ChatGPT + OpenCode style

Live chat app: **Crouton Alpha Free by default**, every free model, **Default / Medium / Max** thinking, **Chat / Build website / Build fullstack** modes, GitHub connect, live preview.

## Features (OpenCode-like)
- **Chat** like ChatGPT: centered, sidebar sessions + search + delete, model/think pickers, copy buttons, safe markdown, auto-guest (never stuck).
- **Build website:** set Mode → 🌐 Build website, AI returns a complete single-file HTML in a code block → right panel shows **Live Preview (sandboxed) + Files**, download HTML.
- **Build fullstack:** same flow with Node + HTML file blocks.
- **GitHub connect:** header chip shows status (`/api/github/status`). Connect via OAuth (setup in README), or keep using Guest/Email with zero setup.
- **Logins:** Guest (instant, auto on load) · Email · GitHub · Google · separate Admin panel (`/admin`).
- **Secure server-side:** headers/CSP, rate limits, httpOnly sessions. Keys never in browser.
- **Live free model:** custom upstream (env) → Pollinations free (no key, ~30s/IP) → demo fallback. No crash on limits.

## Run
```bash
export ADMIN_PASSWORD=your-strong-password
node server.js
# Chat: http://127.0.0.1:3000
# Admin: http://127.0.0.1:3000/admin
```

## Env (server only, never commit)
```bash
PORT=3000
APP_URL=http://127.0.0.1:3000
ADMIN_PASSWORD=...
OPENCODE_API_BASE=https://your-provider.example/api
OPENCODE_API_KEY=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## GitHub OAuth setup
GitHub → Settings → Developer settings → OAuth Apps → New. Homepage `http://127.0.0.1:3000`, Callback `/auth/github/callback`. Then set env + restart. Google: Cloud Console → OAuth → redirect `/auth/google/callback`.

## Test
```bash
node --check server.js
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/github/status
curl -X POST http://127.0.0.1:3000/api/auth/guest
curl -X POST http://127.0.0.1:3000/api/chat -H 'Content-Type: application/json' -d '{"model":"opencode/crouton-alpha-free","think":"medium","mode":"chat","messages":[{"role":"user","content":"Hi"}]}'
```
