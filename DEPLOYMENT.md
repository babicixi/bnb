# Deployment

Deploy this app to Render with a custom domain (e.g. `your-domain.com`)
and an optional Webflow-managed landing page.

> **TL;DR**: Render runs the Express app on `your-domain.com`, with a
> persistent disk holding `state.json` + uploaded photos. Webflow (optional)
> hosts the public landing page; Express proxies `/` to it. Designer publishes
> in Webflow → live within seconds, no code deploy.

---

## What's already wired up

The repo is deploy-ready. The relevant pieces:

- `src/server/index.ts` — reads `DATA_DIR` (or `STATE_FILE` / `UPLOADS_DIR`)
  from env so the persistent disk can hold state.
- `src/server/app.ts` — sets `trust proxy` and `cookie.secure` automatically
  when `NODE_ENV=production`. Adds `GET /healthz` for the host's health check.
- `render.yaml` — Render Blueprint for one-click deploy with a 10 GB disk
  mounted at `/data` and `SESSION_SECRET` auto-generated.
- `.env.example` — all environment variables documented.

---

## Step 1 — Push this repo to GitHub

```bash
git remote add origin git@github.com:<your-handle>/bnb.git
git push -u origin master
```

A private repo is fine — Render reads private repos once you authorize the
Render GitHub App.

## Step 2 — Buy the domain

Use **Cloudflare Registrar** (~$10/year, no markup; CNAME flattening works
with Render out of the box). If you already bought from another registrar,
either keep DNS there (use A records — Render IPs change rarely) or transfer
DNS to Cloudflare for cleaner apex-domain handling.

## Step 3 — Deploy on Render

**Easiest: Blueprint (uses `render.yaml`)**

1. Render dashboard → **New +** → **Blueprint** → connect your GitHub repo.
2. Render reads `render.yaml`, shows you the planned web service + 10 GB disk
   + auto-generated `SESSION_SECRET`. Confirm.
3. Wait ~3–5 minutes for the first build. The deploy log will show
   `▶ booking app listening on http://localhost:10000` and the auto-generated
   URL `https://bnb-XXXX.onrender.com` becomes live.
4. Visit that URL to confirm everything renders.

**Manual fallback** (if you want to skip the blueprint): New + → Web Service
→ pick the repo → build `npm install`, start `npm start`, **add a 10 GB
persistent disk mounted at `/data`**, set env vars
`NODE_ENV=production`, `DATA_DIR=/data`,
`SESSION_SECRET=<a 64-char random hex string>`,
`PORT` is set automatically by Render. Health check path: `/healthz`.

## Step 4 — Attach the custom domain

1. Render → your service → **Settings → Custom Domains** → add
   `your-domain.com` and `www.your-domain.com`.
2. Render shows you the DNS records to create. Typically:
   - `your-domain.com` (apex) → an `A` record pointing at Render's IP, or
     a `CNAME` to `bnb-XXXX.onrender.com` if your DNS provider
     supports CNAME flattening (Cloudflare does).
   - `www.your-domain.com` → `CNAME` to the same Render hostname.
3. Add those records in Cloudflare DNS (or your registrar's DNS panel).
4. Wait 5–10 minutes. Render's domain status flips to **Verified** and a
   free Let's Encrypt SSL certificate is issued automatically.
5. `https://your-domain.com` is now live.

## Step 5 — Add the Webflow landing page proxy *(after Webflow site is published)*

When the designer publishes the landing page in Webflow (e.g. at
`your-landing.webflow.io`), add a tiny proxy so `your-domain.com/` serves
the Webflow site while every other route stays on Express.

```bash
npm install http-proxy-middleware
```

In `src/server/app.ts`, *above* the `mountAuthRoutes(app, repo)` line:

```ts
import { createProxyMiddleware } from "http-proxy-middleware";

const WEBFLOW_HOST = process.env.WEBFLOW_HOST;
if (WEBFLOW_HOST) {
  app.get("/", createProxyMiddleware({
    target: `https://${WEBFLOW_HOST}`,
    changeOrigin: true,
  }));
}
```

Add `WEBFLOW_HOST=your-landing.webflow.io` to Render's env vars and redeploy.
After that, the designer publishes in Webflow → live on `your-domain.com`
on the next request, no Render deploy needed.

Hand the designer a **Link Map** so every CTA points back into the Express
app on the same domain:

| Designer's button | href to use |
|---|---|
| Each "Book this room" | `/rooms/<roomId>` (one per room) |
| "Browse all rooms" | `/rooms` |
| "Find my booking" | `/lookup` |
| Phone reservations | `tel:0966699738` |
| Phone customer service | `tel:0988643307` |
| Facebook | your full Facebook page URL |
| Instagram | your full Instagram profile URL |
| TikTok | your full TikTok profile URL |
| Language switch (Vietnamese) | `/?locale=vi` |
| Language switch (English) | `/?locale=en` |
| Staff login | `/login` |

---

## Going forward

- **Code changes**: `git push` to the connected branch → Render auto-deploys
  in ~1 minute. Persistent disk (state + uploads) is preserved across deploys.
- **Landing-page changes**: designer publishes in Webflow → live within seconds.
- **Logs**: Render dashboard → Logs tab. Or `render logs --service bnb`
  if you install the Render CLI.

## Environment variables reference

| Var | Purpose | Required |
|---|---|---|
| `NODE_ENV` | `production` enables secure cookies, trust-proxy, silences demo logins | Yes (production) |
| `DATA_DIR` | Persistent disk mount path. `state.json` + `uploads/` live underneath | Yes (production) |
| `SESSION_SECRET` | Long random string for signing session cookies | Yes (refuses to start in prod with the default) |
| `PORT` | HTTP listener port. Render/Fly set this automatically | No |
| `STATE_FILE` | Override path to the JSON state file | No |
| `UPLOADS_DIR` | Override the uploads directory | No |
| `WEBFLOW_HOST` | Webflow publish hostname (e.g. `your-landing.webflow.io`) — only set after the proxy snippet is added | No |

## Backup

The persistent disk is reasonably durable (Render snapshots are taken
periodically), but for belt-and-braces add a nightly off-disk backup of
`state.json`:

- Easiest: enable Render's **Disk Snapshots** in the disk settings (paid
  plans only — toggle on, choose retention).
- Off-platform: a nightly cron job that uploads `/data/state.json` to
  Google Drive via [`rclone`](https://rclone.org/), or to S3 via `aws s3 cp`.

`uploads/` images can be regenerated by re-uploading from the source
device, but the same backup job can include them if you want zero data loss.

## When to graduate from JSON state to a real database

Stay on the file-based repo until any of these are true:

- More than one Render instance is needed (file races + sessions break).
- The state file grows past ~50 MB (slow boot times).
- Multiple admins routinely edit at the same second.
- Reports get slow because the in-memory repo can't index efficiently.

For small-operator scale (~6 rooms, single owner), you'll likely never hit
those. When you do, the natural next step is **Supabase Postgres + Supabase
Storage** (~$25/mo); the migration is a one-off script that reads
`state.json` and INSERTs each entity into SQL tables. Plan for that when it
becomes a real bottleneck — not before.

## Health check & smoke test after deploy

```bash
curl https://your-domain.com/healthz
# → {"ok":true,"ts":"2026-..."}

curl -I https://your-domain.com/
# → 200 OK (or a 302 to Webflow once the proxy is wired)

curl https://your-domain.com/rooms/room-1
# → HTML page rendered by Express
```

If `/healthz` is green but pages don't render, check Render Logs for
errors — most commonly a missing env var or a permission issue on `/data`.
