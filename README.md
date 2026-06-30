# CodeSync — Real-time Collaborative Code Editor (Production Edition)

A secure, production-ready collaborative code editor. Multiple users write code together in real-time with live cursors, chat, and password-protected rooms.

---

## What's New in This Version

| Area | Change |
|---|---|
| **Auth** | JWT-based session tokens issued on room join, verified on every WebSocket connection |
| **Room security** | Optional bcrypt-hashed room passwords |
| **Persistence** | Redis-backed storage — rooms and code survive server restarts |
| **HTTP security** | Helmet (CSP, HSTS, and other security headers), strict CORS whitelist |
| **Input safety** | All chat messages and usernames sanitized against XSS; room IDs validated against injection |
| **Abuse prevention** | Rate limiting on room creation and API routes, payload size caps |
| **Resilience** | Graceful handling of port conflicts, CORS errors, and auth failures |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 7, Tailwind CSS 4 |
| Editor | Monaco Editor |
| Real-time | Socket.io v4, Yjs CRDTs, y-socket.io |
| Backend | Node.js, Express 5 |
| Auth | JWT (jsonwebtoken), bcryptjs |
| Security | Helmet, cors, express-rate-limit, validator |
| Persistence | Redis |
| DevOps | Docker (multi-stage), Docker Compose |

---

## Run Locally

### 1. Backend

```bash
cd Backend
cp .env.example .env
```

Edit `.env` and set a real `JWT_SECRET` (generate one with `openssl rand -base64 48`).

```bash
npm install
npm run dev
```

Runs on `http://localhost:3000`. Without `REDIS_URL` set, it falls back to in-memory storage automatically (fine for local dev).

### 2. Frontend (new terminal)

```bash
cd Frontend
npm install
npm run dev
```

Runs on `http://localhost:5173` with API/WebSocket calls proxied to the backend.

### 3. With Redis (recommended, matches production)

```bash
docker compose up --build
```

This starts the app **and** a Redis container together. Open `http://localhost:3000`.

---

## Deploying to Production

### Step 1 — Get a domain and HTTPS

WebSockets and the password feature both require HTTPS in production (browsers block mixed content and some Yjs awareness features over plain HTTP). Use:
- **Render / Railway / Fly.io** — HTTPS is automatic, simplest path for a first deploy
- **AWS EC2 + Nginx + Let's Encrypt** — more control, more setup

### Step 2 — Set real environment variables

Never reuse the example `.env` values in production:

```bash
JWT_SECRET=<run: openssl rand -base64 48>
NODE_ENV=production
CORS_ORIGIN=https://your-actual-domain.com
REDIS_URL=redis://<your-redis-host>:6379
```

A managed Redis instance (Upstash, Render Redis, AWS ElastiCache) is recommended over self-hosting for a first production deploy — Upstash has a free tier that works well here.

### Step 3 — Reverse proxy WebSockets correctly

If you put Nginx in front of the app, WebSocket upgrade headers must be forwarded or real-time sync will silently fail:

```nginx
location /socket.io/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

### Step 4 — Verify before going live

```bash
curl https://your-domain.com/health
# should return {"message":"ok","success":true,"redis":true}
```

If `redis` is `false` in production, your `REDIS_URL` isn't set correctly and rooms won't survive restarts.

---

## Security Checklist Before Publishing

- [ ] `JWT_SECRET` is a long random value, not the example default
- [ ] `CORS_ORIGIN` is set to your real domain, not `*`
- [ ] Site is served over HTTPS
- [ ] `REDIS_URL` points to a real Redis instance (not in-memory fallback)
- [ ] `.env` is in `.gitignore` and was never committed to git
- [ ] Tested room password protection: wrong password is rejected, correct one works
- [ ] Confirmed rate limiting triggers on rapid repeated requests

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3000) | Server port |
| `NODE_ENV` | Recommended | `production` enables stricter startup checks |
| `JWT_SECRET` | **Yes in production** | Signs session tokens — server refuses to start without it in production mode |
| `CORS_ORIGIN` | **Yes in production** | Comma-separated list of allowed frontend origins |
| `REDIS_URL` | Recommended | Enables persistent rooms; omit for in-memory fallback (dev only) |

---

## Known Limitations / Next Steps

- Room creator has no special permissions yet beyond setting the password (no kick/ban)
- Chat history is capped at 50 messages per room and isn't persisted to Redis (only the code document is)
- No file upload or multi-file project support yet
- Code execution sandbox not included — adding one safely requires a separate isolated worker process, which is a bigger follow-up project

---

## Resume Bullet Points

> Built and deployed a production-ready real-time collaborative code editor with JWT-authenticated WebSocket sessions, bcrypt-hashed room passwords, Redis-backed document persistence, and hardened HTTP security (Helmet, CORS whitelisting, rate limiting, input sanitization). Containerized with Docker Compose for reproducible deployment.
