# Claude Code session notes

## Credentials

API tokens for Render, Cloudflare, and GitHub live in
[`.local/tokens.md`](./.local/tokens.md) — gitignored, project-local only.

Read that file at the start of any session that needs to:
- talk to Render's API (deploys, logs, custom domains, env vars)
- talk to Cloudflare's API (DNS edits on `cixiwanderlust.com`)
- push to GitHub (`babicixi/bnb`)

The user owns the choice to revoke any token at any time. If a token in
`.local/tokens.md` no longer works, ask before generating a new one.

## Production summary

- **Live URL**: https://cixiwanderlust.com
- **GitHub**: `babicixi/bnb` (default branch `master`). `1e9investments` is a
  push collaborator. The local `.git/config` remote has the GitHub PAT
  embedded so `git push` works without prompting.
- **Hosting**: Render web service `cixi-bnb` in Singapore region, with a
  10 GB persistent disk at `/data` holding `state.json` + `uploads/`.
- **DNS**: Cloudflare nameservers; both apex and `www` are CNAMEs to
  `cixi-bnb.onrender.com` (proxy off — required for Render's Let's Encrypt SSL).
- **Auto-deploy**: every push to `master` triggers a Render rebuild (~1 min).

## Local dev gotchas

- Project lives on Google Drive (DriveFS). `tsx watch` periodically dies with
  `FSWatcher UNKNOWN` errors — relaunch the dev server when that happens.
- DriveFS occasionally corrupts `node_modules/typescript/package.json` mid-session
  (causing `ERR_INVALID_PACKAGE_CONFIG`). Workaround per the user's prior note:
  install in `C:\Temp\bnb-verify` and rsync `node_modules` back. Local lint /
  typecheck / test failures from this cause are environmental, not code bugs —
  Render's clean Linux container is the source of truth.
- Default locale is `vi`; pass `?locale=en` for English smoke tests.
- Default `SESSION_SECRET=dev-secret-change-me` is fine for dev. Production
  refuses to start with that value (handled in `src/server/index.ts`).
