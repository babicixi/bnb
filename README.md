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

`checkAvailability` blocks a requested window when it overlaps:

- an active hold
- a non-cancelled booking
- the 1-hour cleaning buffer after checkout

## Payment Flow

The initial payment method is static bank transfer.

1. Guest books and receives a booking number.
2. Guest uploads a bank transfer screenshot.
3. `uploadPaymentProof` creates the proof record.
4. `confirmBookingAfterPaymentProof` automatically sets the booking to `confirmed`.
5. Payment status becomes `proof_uploaded`.

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
npm run typecheck
npm run lint
npm test
npm run format
```

Note: on Windows, installing into a Google Drive (DriveFS) path may fail because esbuild's postinstall cannot write through the DriveFS layer. The workaround used here is to install into a local copy on `C:` for verification (`robocopy` the source, `npm install` there, run scripts there), or to put `node_modules` on a junction to a local NTFS volume.

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
