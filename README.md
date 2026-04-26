# Vietnam Short-Stay Booking Backend

Initial backend foundation for Vietnam apartment and room short-stay bookings.

## Stack

- TypeScript
- Vitest for unit tests
- PostgreSQL/Supabase-style SQL migrations
- Framework-neutral services under `src/services`

The current project directory did not contain an existing application stack, package manager files, database setup, test framework, or git repository. This scaffold uses `npm` and keeps domain logic independent from any future HTTP framework.

## Project Layout

- `migrations/0001_initial_schema.sql`: PostgreSQL schema for rooms, guests, bookings, holds, payments, discounts, commissions, minibar, cleaning, cancellations, refunds, and future OTA sync fields.
- `seeds/0001_seed.sql`: Seed data for users, roles, one building, rooms, sample pricing, minibar items, discounts, commission rules, and cleaning crew availability.
- `src/domain`: Shared types and time helpers.
- `src/services`: Core booking, pricing, payment, cancellation, commission, cleaning, and permission logic.
- `tests/booking-platform.test.ts`: Unit tests for the required business rules.

## Booking Lifecycle

Guests do not create accounts. A booking is tracked by a `booking_number`, guest contact details, room, booking type, check-in/check-out times, status, payment state, charges, deposit, and future OTA sync fields.

Primary statuses:

- `held`
- `pending_payment`
- `confirmed`
- `checked_in`
- `checked_out`
- `cleaning_assigned`
- `cleaning_in_progress`
- `cleaned`
- `extra_payment_required`
- `refund_pending`
- `cancellation_requested`
- `cancelled`
- `closed`

When a guest selects a room and time, `createHold` creates a 15-minute hold. Active holds block everyone, including admins. `expireOldHolds` marks expired holds so they no longer block availability.

`createBookingFromHold` converts an active hold into a `Booking` (status `pending_payment`, payment status `pending`) and a `Payment` stub (method `bank_transfer`). The hold is marked expired since the booking itself now blocks the slot.

Operational lifecycle helpers (admin/manager only):

- `checkInGuest(booking, by)` — `confirmed` → `checked_in`.
- `checkOutGuest(booking, by, cleaning?)` — `checked_in` → `checked_out`; optionally auto-assigns a cleaning job and flips status to `cleaning_assigned`.
- `closeBooking(booking, by)` — `cleaned` / `checked_out` / `refund_pending` / `extra_payment_required` → `closed`.

`checkAvailability` blocks a requested window when it overlaps:

- an active hold
- a non-cancelled booking
- the 1-hour cleaning buffer after checkout

## Payment Flow

The initial payment method is static bank transfer.

1. Guest books and receives a booking number.
2. Guest uploads a bank transfer screenshot.
3. `uploadPaymentProof` creates the proof record.
4. `confirmBookingAfterPaymentProof` automatically sets the booking to `confirmed`, sets payment status to `proof_uploaded`, and marks `amountPaidVnd` as the full collectable amount.
5. Optionally, `applyConfirmationSideEffects({ booking, commissionRules, cleaning? })` populates `calculatedCommissionVnd` and creates the cleaning job up-front (without flipping booking status) so the schedule is set as soon as the stay is confirmed.

Admin or manager can later call `markPaymentProofInvalid`, which moves the booking back to `pending_payment` and payment status to `proof_invalid`.

## Pricing Rules

`normalizeBookingTimes` enforces booking time rules:

- Hourly booking can start anytime.
- Same-day hourly checkout remains hourly.
- Hourly checkout crossing midnight converts to a day booking.
- Converted hourly checkout becomes 11:00 the next day.
- Day booking check-in must be at or after 14:00.
- Day booking checkout becomes 11:00 the next day.
- Multi-day booking check-in must be at or after 14:00.
- Multi-day checkout becomes 11:00 on the requested departure date.

`calculateBookingPrice` uses the room daily pricing calendar. Day and multi-day prices sum daily rates by Vietnam local calendar day. Hourly bookings use the hourly rate and round up to full hours. Initial amount to collect is:

```text
net room charge + VND 500,000 security deposit
```

Discounts can be global or agent-specific, percentage or fixed, active/inactive, and date-bounded. Agent-specific discounts only apply when the booking sales agent matches the discount.

## Cancellation And Refunds

Sales agents can request cancellation with `requestCancellation`; they cannot approve it. Admin or manager approves with `approveCancellation`. Admin retains final cancellation authority operationally.

Cancellation fee is based on the time between cancellation and check-in:

- More than 3 days before check-in: 0%
- Between 3 days and 1 day before check-in: 30%
- Within 24 hours of check-in: 50%

Refund formula:

```text
refund_due =
amount_paid
- final_room_charge
- cancellation_fee_if_any
- minibar_charges
- damage_charges
```

`calculateRefund` clamps refunds at zero.

Booking edits use `editBookingTimes` to recalculate totals. Extensions set `amount_due_vnd` and `extra_payment_required` when the new total is higher than the amount already paid. Shortened bookings calculate `refund_due_vnd` and set `refund_pending` when money should be handled back after stay closeout.

## Commissions

`calculateAgentCommission` supports:

- percentage commission based on net amount after discount
- fixed commission per confirmed booking
- active/inactive rules
- date validity windows

The schema stores `calculated_commission_vnd` on `bookings`; a future commission ledger can be added if payout workflow needs an audit trail separate from bookings.

## Cleaning Assignment

`autoAssignCleaningJob` creates a job after checkout is known. The cleaning window begins at checkout time and lasts one hour. It assigns the first available cleaner whose availability covers the full window and stores the cleaner's fixed pay on the job.

Cleaning crew lifecycle services advance job status and reflect side effects on the booking:

- `markCleaningArrived(job, user)` — `assigned` → `arrived`, stamps `arrivedAt`.
- `startCleaning(job, booking, user)` — `assigned`/`arrived` → `in_progress`, sets booking to `cleaning_in_progress`.
- `completeCleaning(job, booking, profile, user)` — `in_progress` → `completed`, sets booking to `cleaned`, increments `profile.jobsCompleted`.
- `reportMinibarUsage({ job, booking, item, quantity, user })` — creates a `MinibarUsage` record and adds the line total to `booking.minibarChargesVnd`.
- `reportCleaningDamage({ job, booking, user, damageChargesVnd, notes })` — accumulates damage on both the job and the booking and appends notes.
- `addCleaningPhoto({ job, user, photoUrl })` — appends a photo URL to the job (no storage backend wired yet).
- `rateCleaning({ job, profile, ratedBy, rating, existingRatingsCount })` — admin/manager only, requires `completed`, updates the running average on the cleaner's profile.

All cleaning-job mutators allow admin and manager, but otherwise restrict updates to the assigned `cleaning_crew` user.

## Permissions

- Admin: full access.
- Manager: operational access for booking/payment/cancellation management.
- Sales agent: create/edit/view own bookings, view own guest contact details, request cancellation, apply allowed discounts, view own commission.
- Cleaning crew: assigned cleaning jobs and operational reporting only.

`bookingGuestViewForUser` redacts guest contact details from sales agents who do not own the booking.

## Running Locally

Install Node.js first.

```bash
npm install
npm run dev          # boot the web app on http://localhost:3000
npm run start        # boot without watch
npm run typecheck
npm run lint
npm test
npm run format
```

`npm run dev` boots the Express app at `http://localhost:3000`. The console prints six demo logins:

| role            | email                    | password        | landing |
|-----------------|--------------------------|-----------------|---------|
| admin           | admin@example.com        | admin12345      | `/admin` |
| manager         | manager@example.com      | manager12345    | `/admin` |
| sales_agent     | agent1@example.com       | agent12345      | `/agent` |
| sales_agent     | agent2@example.com       | agent12345      | `/agent` |
| cleaning_crew   | cleaner1@example.com     | cleaner12345    | `/cleaning` |
| cleaning_crew   | cleaner2@example.com     | cleaner12345    | `/cleaning` |

Note: on Windows, installing into a Google Drive (DriveFS) path may fail because esbuild's postinstall cannot write through the DriveFS layer. The workaround used here is to install into a local copy on `C:` for verification (`robocopy` the source, `npm install` there, run scripts there), or to put `node_modules` on a junction to a local NTFS volume.

## Stage 2 — End-to-end web workflow

The Express app under `src/server/` exposes:

### Guest flow (no login)

1. `GET /` — buildings + rooms list.
2. `GET /rooms/:id` — room detail with availability/booking form (room, type, check-in, check-out, guest name+phone, optional email/notes).
3. `POST /book/hold` — server validates availability, creates a 15-minute hold + booking + payment record, then redirects to the booking page.
4. `GET /book/:bookingNumber` — booking summary + bank-transfer instructions + countdown until payment deadline + screenshot upload form.
5. `POST /book/:bookingNumber/upload-proof` — multer accepts an image, calls `uploadPaymentProof` + `applyConfirmationSideEffects` (commission + cleaning auto-assign), redirects to confirmation. After the deadline the route returns `410` and cancels the booking.
6. `GET /book/:bookingNumber/confirmation` — final confirmation page.
7. `GET /lookup` and `POST /lookup` — guest looks up a booking by number + matching phone.

Page text is wired through a tiny `t(key)` helper at `src/server/i18n.ts`. Switch with `?locale=vi` / `?locale=en`.

### Admin / manager (`/admin/*`, requires `admin` or `manager`)

- Dashboard with filters (status, payment status, building, room, sales agent, date range).
- Booking detail with edit (recalculates → `extra_payment_required` or `refund_pending`), cancel (records + approves a `cancellation_request`), mark proof invalid, internal notes, and assign/reassign cleaning crew.
- `/admin/refunds` and `/admin/extras` shortlists.
- `/admin/price-preview` JSON helper for inline price checks.

### Sales agent (`/agent/*`, requires `sales_agent`)

- Sees only own bookings; running commission total at the top.
- New booking form with allowed discount picker (global + agent-specific).
- Booking detail uses `bookingGuestViewForUser` so other agents' bookings render guest fields blank.
- Request cancellation (status moves to `cancellation_requested`; admin must approve).

### Cleaning crew (`/cleaning/*`, requires `cleaning_crew`/`admin`/`manager`)

- Sees only assigned jobs (admin/manager see all).
- Status transitions: `arrived` → `start` → `complete`.
- Report minibar usage (adds to booking minibar charges) and damages (adds to job + booking damage charges).
- Photo URL placeholder field (file storage not wired).

### Permissions

Server-side enforcement via `requireRole` middleware mounted on each role's router. Sales-agent ownership is checked per-booking. Cleaner job-ownership is checked in `loadJobOr404`.

### Notifications

`src/services/notifications.ts` exposes a Node `EventEmitter` with the events listed in the Stage 5 spec (`booking_hold_created`, `booking_confirmed`, `payment_proof_uploaded`, `payment_proof_invalid`, `cancellation_requested`, `cancellation_approved`, `cleaning_assigned`, `cleaning_started`, `cleaning_completed`, `minibar_reported`, `damage_reported`, `extra_payment_required`, `refund_pending`, `hold_expired`, …). No transport (email/SMS/Zalo) is wired — listen on the emitter to integrate later.

### Persistence

Stage 2 uses an in-memory repository (`src/repo/memory.ts`) seeded at boot (`src/repo/seed.ts`). `migrations/0001_initial_schema.sql` + `migrations/0002_booking_notes_and_source.sql` are the deployment-target Postgres schema. Switching to Postgres later is a matter of swapping the repository implementation behind the same shape — `src/services/` does not change.

### Known limitations

- No real persistence (in-memory only). Restart loses bookings.
- No file-storage backend for uploads beyond a local `uploads/` directory; production should use S3/Supabase Storage.
- `expireOldHolds` is invoked lazily on each `POST /book/hold` and `/agent/new`. A scheduled job (Stage 3) should sweep regularly so booked-but-unpaid windows free up automatically.
- No email/SMS — see notification placeholders above.
- No CSRF protection on forms (Stage 8).
- Day-rate booking can only be extended by editing it as `multi_day` (admin would need to re-create as multi_day to extend a one-night stay; the edit route preserves the original booking type).

Apply database files with your preferred PostgreSQL/Supabase migration runner:

```bash
psql "$DATABASE_URL" -f migrations/0001_initial_schema.sql
psql "$DATABASE_URL" -f seeds/0001_seed.sql
```

## Assumptions

- Vietnam time is treated as fixed UTC+07 in the domain services.
- Unit tests do not require a live database.
- Services mutate passed booking/payment objects where the business operation naturally updates state.
- No API transport, auth provider, file storage, or OTA sync is implemented yet.
