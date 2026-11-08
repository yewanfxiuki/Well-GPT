# Well-GPT (Crouton AI) — Live, Free, Secure

Live chat app like OpenCode: **Crouton Alpha Free by default**, every free model, **Default / Medium / Max** thinking, polished UI/UX, and **many login options**.

## What's new
- **Live model, no key:** server tries custom upstream → **Pollinations free live** (no key, ~30s/IP best-effort) → smart demo fallback. No token needed to chat.
- **UI/UX:** gradient hero, model + think pickers, sidebar chats, copy buttons, dark/light toggle, sticky composer, fully responsive.
- **Logins (pick any):** Guest (instant) · Email (demo magic-link style) · GitHub OAuth · Google OAuth · separate Admin panel
- **Secure server-side:** headers/CSP, rate limits, size limits, input validation, httpOnly sessions, timing-safe admin password. Keys never in browser.

## Run
```bash
export ADMIN_PASSWORD=your-strong-password
node server.js
# Chat: http://127.0.0.1:3000
# Admin: http://127.0.0.1:3000/admin
```

## Env (server only)
```bash
PORT=3000
APP_URL=http://127.0.0.1:3000
ADMIN_PASSWORD=...
# optional true-Crouton upstream (OpenAI-compat, key server-side only)
OPENCODE_API_BASE=https://your-provider.example/api
OPENCODE_API_KEY=
# optional OAuth (create apps, set callback /auth/github/callback and /auth/google/callback)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## Logins
- **Guest / Email:** work out of the box, httpOnly `user_session` cookie.
- **GitHub:** GitHub → Settings → Developer settings → OAuth Apps → Homepage `http://127.0.0.1:3000`, Callback `/auth/github/callback`.
- **Google:** Google Cloud Console → OAuth credentials → redirect `/auth/google/callback`.
- **Admin:** `/admin` with `ADMIN_PASSWORD`.

## Security (honest limits)
No site is "unhackable." Use HTTPS in production, strong admin password, never commit `.env`, update Node. Secrets stay on server.

## Test
```bash
node --check server.js
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/models
curl -X POST http://127.0.0.1:3000/api/auth/guest
curl -X POST http://127.0.0.1:3000/api/chat -H 'Content-Type: application/json' -d '{"model":"opencode/crouton-alpha-free","think":"medium","messages":[{"role":"user","content":"Hi"}]}'
```
