# Crouton AI — Your Own AI App

Full-stack AI app like OpenCode with good UI/UX, server-side security, separate admin panel, GitHub login, and free models.

## Features
- **Chat UI:** sidebar with history, model picker, think levels **Default / Medium / Max**, mobile-friendly, XSS-safe rendering
- **Models (all free in OpenCode):** Crouton Alpha Free, Iceman Free, Inkling 2 Small Free, Flint 40B Free, Nemotron 3.5 Super VL Free, Beam Free, MiMo-V2.6-Flash Free, DeepSeek V4.1 Flash Free, GLM-5.3-Flash Free, Big Pickle
- **Think levels:** `default` → medium reasoning, `medium` → high, `max` → max (sent as variant hint server-side)
- **Secure server-side:** Node built-ins only, security headers, CSP, rate limiting, body-size limits, input validation, timing-safe admin password check, httpOnly cookie session, no secrets in browser
- **Separate admin panel:** `/admin` — health stats + logs, protected by `ADMIN_PASSWORD`
- **GitHub:** OAuth stub at `/auth/github` (set Client ID/Secret on server only)
- **No token needed to run:** demo mode replies locally; add live upstream via env to get real model replies

## Run it
```bash
npm start
# open chat: http://127.0.0.1:3000
# open admin: http://127.0.0.1:3000/admin
```

## Configure (server env only — never in browser code)
```bash
export PORT=3000
export ADMIN_PASSWORD=your-strong-password
# optional live model upstream (OpenAI-compatible)
export OPENCODE_API_BASE=https://your-provider.example/api
export OPENCODE_API_KEY=
# optional GitHub OAuth
export GITHUB_CLIENT_ID=
export GITHUB_CLIENT_SECRET=
export APP_URL=http://127.0.0.1:3000
node server.js
```
> Note: Node doesn't auto-load `.env`. Either export vars in your shell/systemd, or add a loader. `.env.example` is just a template.

## GitHub setup (if you want GitHub login)
1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Homepage URL: your app URL (e.g. `http://127.0.0.1:3000`)
3. Authorization callback URL: `http://127.0.0.1:3000/auth/github/callback`
4. Copy Client ID + Client Secret **to server env only**, restart, then use **Sign in with GitHub**

## Security — honest limits
No website can be "unhackable." This app uses best practices (headers, rate limits, validation, least privilege, no client secrets) to reduce risk, but you must:
- Use **HTTPS** in production, keep Node updated, use strong admin password, set `ADMIN_PASSWORD`, never commit `.env`
- Rotate keys, monitor logs in the admin panel, consider a managed host for production
- Don't ask users for secrets; validate all input server-side (already done)

## Safe to push to GitHub?
Yes — push code + `.env.example`, **never** `.env`. `.gitignore` already ignores secrets.

## Test
```bash
node --check server.js
node --check public/app.js
node --check public/admin.js
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/models
```
