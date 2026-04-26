# Stage Plan & Checklist

This file tracks per-stage progress against the spec in `Nam documentation.docx`. Mark each item `[x]` when done, `[~]` when partially done with notes, `[ ]` when pending.

## Architecture decisions made for this scaffold

- **Server**: Express 4 + EJS templates (server-rendered). Chosen over Next.js because Windows + DriveFS makes Next's native deps fragile, and SSR gives mobile-friendly forms with zero client JS.
- **Persistence (MVP)**: in-memory Repository (`src/repo/`) seeded at boot. Postgres schema in `migrations/0001_initial_schema.sql` is the deployment target; switching repos to a SQL implementation is a later step.
- **Auth**: `express-session` cookie sessions + bcryptjs hashed staff passwords. Guests have no accounts (per spec).
- **File uploads**: `multer` writes to `uploads/` local dir. Production should swap to S3/Supabase Storage.
- **Validation**: `zod`.
- **Tests**: vitest + supertest for HTTP, plus the original pure-function tests.

When the main process is later containerised or deployed, the in-memory repo gets replaced by a SQL-backed one against `migrations/`. The service layer in `src/services/` does not change.

## Stage 1 — Backend foundation

Status: COMPLETE (committed `1c1275f`, README at `e4a99b1`).

- [x] Schema + seeds
- [x] Domain types and Vietnam-time helpers
- [x] All 12 required service functions
- [x] All 22 required tests (now 41 tests total)
- [x] Booking creation from hold, confirmation side effects, lifecycle helpers, permission helpers
- [x] README sections per spec
- [x] git initialized with baseline commit

## Stage 2 — MVP workflow & role dashboards

Goal: end-to-end booking flow + role dashboards. Server-rendered EJS, in-memory repo, cookie sessions.

### 2.1 Web stack scaffold

- [x] Add deps: express, ejs, express-session, bcryptjs, multer, cookie-parser, zod, tsx, supertest, plus @types
- [x] `src/server/app.ts` — Express factory (so tests can boot without listen)
- [x] `src/server/index.ts` — start listener
- [x] EJS view layer + base layout, public CSS
- [x] `npm run dev` script, `npm run start` script

### 2.2 Persistence + auth

- [x] `src/repo/memory.ts` — in-memory repository (rooms, buildings, users, bookings, holds, payments, payment proofs, cleaning jobs, cleaning availability, cleaning crew profiles, discounts, commission rules, minibar items, cancellation requests)
- [x] `src/repo/seed.ts` — boot seed (1 admin, 1 manager, 2 agents, 2 cleaners, 1 building, 3 rooms, daily rates, minibar, discounts, commission rules, cleaner availability)
- [x] `src/server/middleware/session.ts` — express-session config
- [x] `src/server/middleware/auth.ts` — `requireRole('admin'|'manager'|...)`
- [x] `src/server/routes/auth.ts` — `/login`, `/logout`
- [x] Demo passwords (printed at boot)

### 2.3 Public guest booking flow

- [x] `/` homepage — building & rooms list
- [x] `/rooms/:id` — room detail with availability search form
- [x] `/book/availability` — POST availability check
- [x] `/book/hold` — POST creates 15-min hold + booking + payment record
- [x] `/book/:bookingNumber/upload-proof` — multipart upload → confirms booking
- [x] `/book/:bookingNumber/confirmation` — confirmation page
- [x] Hold countdown shown to guest
- [x] Payment upload blocked after hold expiry
- [x] Translation-ready text helper (en + vi minimal)

### 2.4 Admin/manager dashboard

- [x] `/admin` — bookings list with filters (date range, room, building, status, payment status, agent)
- [x] `/admin/bookings/:id` — detail view
- [x] Edit times (recalculates → extra_payment_required or refund_pending)
- [x] Cancel booking
- [x] Mark payment proof invalid
- [x] Assign/reassign cleaning crew
- [x] Pending refunds / extra payments view
- [x] View uploaded proofs
- [x] Internal notes

### 2.5 Sales agent dashboard

- [x] `/agent` — own bookings only
- [x] Create booking on behalf of guest
- [x] Apply allowed discounts (global + agent-specific)
- [x] Request cancellation (cannot approve)
- [x] View own commission

### 2.6 Cleaner dashboard

- [x] `/cleaning` — assigned jobs only
- [x] Update status: assigned → arrived → in_progress → completed
- [x] Report minibar usage
- [x] Report damages
- [x] Photo URL placeholder (storage not wired)
- [x] Cannot see financials

### 2.7 Permissions

- [x] All routes guarded server-side (middleware on routers)
- [x] Sales agent cannot view another agent's booking detail
- [x] Cleaner cannot view unrelated jobs

### 2.8 Notification placeholders

- [x] `src/services/notifications.ts` event emitter for the listed events; no transport wired

### 2.9 Tests

- [x] Guest can search availability and create hold
- [x] Guest cannot upload payment after hold expiry
- [x] Guest payment upload auto-confirms booking
- [x] Admin can view all bookings
- [x] Sales agent cannot view another agent's booking
- [x] Sales agent can request cancellation but not approve
- [x] Cleaner can only see assigned jobs
- [x] Admin can mark payment proof invalid
- [x] Booking edit recalculates extra payment / refund
- [x] Discounts apply correctly in agent flow
- [x] Existing 41 backend tests still pass

### 2.10 Definition of done

- [x] End-to-end booking flow works locally
- [x] Role-based dashboards exist
- [x] Permissions enforced server-side
- [x] Tests pass
- [x] README updated with run instructions, demo logins, role workflows, known limitations
- [x] Format / lint / typecheck / tests pass
- [x] Assumptions and skipped items reported

## Stage 3 — Pricing/content/discount/commission/automation/audit

Status: NOT STARTED.

- [ ] Pricing management (bulk edit, copy room→room, preview, history)
- [ ] Discount management (limits, validation, minimum-price guard)
- [ ] Commission management + commission_ledger table & service
- [ ] Room/building CRUD with EN/VI fields
- [ ] Minibar admin CRUD + cleaner usage approval workflow
- [ ] Cleaner availability mgmt (recurring + max-jobs-per-day, override)
- [ ] Operational automation services (expireHolds cron, daily checklist, cleaning-after-confirm, etc.)
- [ ] Audit log table + middleware capturing actor/before/after for booking edits, cancellations, proof invalidation, refund approval, pricing/discount/commission changes, cleaner reassignment
- [ ] Server-side permission enforcement audit
- [ ] All Stage 3 tests
- [ ] README updates

## Stage 4 — Analytics, reports, exports

Status: NOT STARTED.

- [ ] Admin analytics dashboard cards
- [ ] Revenue / occupancy / agent / cleaner reports
- [ ] Refund/payment finance dashboard
- [ ] CSV exports (bookings, revenue, occupancy, commission, payroll, minibar, refunds, audit logs)
- [ ] Charts (or table-first views)
- [ ] Calculation helpers (`calculateGrossRevenue` etc.)
- [ ] Permissions for reports
- [ ] Tests

## Stage 5 — Notifications + lifecycle automation + guest lookup

Status: NOT STARTED.

- [ ] Notification events fully fleshed
- [ ] Channel placeholders (email/SMS/Zalo/WhatsApp/Telegram)
- [ ] Editable EN/VI templates
- [ ] Booking lifecycle automation (no-show, auto-checkout, auto-close)
- [ ] Internal task queue
- [ ] Admin task dashboard
- [ ] Guest booking lookup
- [ ] Message history
- [ ] Tests

## Stage 6 — OTA/iCal foundation + public website polish + maintenance blocks

Status: NOT STARTED.

- [ ] OTA fields finalized
- [ ] iCal import/export services
- [ ] External block model
- [ ] Conflict dashboard
- [ ] Public site polish (mobile-first, EN/VI)
- [ ] SEO basics
- [ ] Editable content (homepage/FAQ/policies)
- [ ] Maintenance blocks
- [ ] Tests

## Stage 7 — PWA + mobile workflows

- [ ] Manifest, icons, mobile layout, optional service worker
- [ ] Mobile-polished guest, agent, cleaner, admin flows
- [ ] Field-friendly UX (large taps, sticky actions, status badges)
- [ ] Offline draft support (or documented)
- [ ] Push notification placeholders
- [ ] Tests

## Stage 8 — Security, compliance, backup, production readiness

- [ ] Auth hardening (sessions, password reset, 2FA placeholder)
- [ ] Server-side authorization audit
- [ ] Sensitive data masking + private file access
- [ ] Input validation everywhere
- [ ] Rate limiting
- [ ] Audit log completeness
- [ ] Backup/restore plan documented
- [ ] `.env.example` + env var validation
- [ ] Monitoring + structured error handling
- [ ] Production deployment checklist
- [ ] Tests

## Stage 9 — Beta launch + QA scripts

- [ ] QA test scripts
- [ ] Beta launch checklist
- [ ] Staff training pages
- [ ] Demo/sandbox seed (separate from prod)
- [ ] Bug report form
- [ ] Feedback form
- [ ] Beta monitoring dashboard
- [ ] Admin data correction tools
- [ ] Tests

## Stage 10 — Post-beta hardening, perf, scale, OTA & payments abstraction

- [ ] Bug-fix sweep + regression tests
- [ ] Race condition / double-booking hardening (DB constraints, locking)
- [ ] Perf optimization (query indexing, caching, no-N+1)
- [ ] UX improvements from feedback
- [ ] Structured logging + request IDs
- [ ] Data integrity tools
- [ ] Soft delete + restore
- [ ] Feature flags
- [ ] OTA integration prep
- [ ] Payment provider abstraction (Stripe / VN gateways)
- [ ] Monitoring/alerting hooks
- [ ] Documentation refresh
- [ ] Tests
