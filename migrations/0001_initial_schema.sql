create extension if not exists "pgcrypto";

create type role_name as enum ('admin', 'manager', 'sales_agent', 'cleaning_crew');
create type booking_type as enum ('hourly', 'day', 'multi_day');
create type booking_status as enum (
  'held',
  'pending_payment',
  'confirmed',
  'checked_in',
  'checked_out',
  'cleaning_assigned',
  'cleaning_in_progress',
  'cleaned',
  'extra_payment_required',
  'refund_pending',
  'cancellation_requested',
  'cancelled',
  'closed'
);
create type payment_status as enum ('pending', 'proof_uploaded', 'proof_invalid', 'verified', 'refunded', 'cancelled');
create type proof_status as enum ('uploaded', 'invalid', 'accepted');
create type discount_scope as enum ('global', 'agent_specific');
create type discount_type as enum ('percentage', 'fixed');
create type commission_type as enum ('percentage', 'fixed');
create type cleaning_job_status as enum ('assigned', 'arrived', 'in_progress', 'completed', 'cancelled');
create type cancellation_status as enum ('requested', 'approved', 'rejected');
create type sync_status as enum ('not_synced', 'pending', 'synced', 'failed');

create table roles (
  id uuid primary key default gen_random_uuid(),
  name role_name not null unique,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references roles(id),
  full_name text not null,
  email text not null unique,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table buildings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  city text not null default 'Ho Chi Minh City',
  district text,
  created_at timestamptz not null default now()
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references buildings(id),
  name text not null,
  room_number text,
  max_guests integer not null default 2,
  base_day_rate_vnd integer not null check (base_day_rate_vnd >= 0),
  base_hourly_rate_vnd integer not null check (base_hourly_rate_vnd >= 0),
  is_active boolean not null default true,
  external_channel text,
  external_calendar_event_id text,
  sync_status sync_status not null default 'not_synced',
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table room_media (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  url text not null,
  alt_text text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table room_daily_rates (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  rate_date date not null,
  day_rate_vnd integer not null check (day_rate_vnd >= 0),
  hourly_rate_vnd integer not null check (hourly_rate_vnd >= 0),
  unique (room_id, rate_date)
);

create table guests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  email text,
  document_number text,
  notes text,
  created_at timestamptz not null default now()
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  booking_number text not null unique,
  room_id uuid not null references rooms(id),
  guest_id uuid not null references guests(id),
  sales_agent_id uuid references users(id),
  booking_type booking_type not null,
  status booking_status not null default 'pending_payment',
  payment_status payment_status not null default 'pending',
  check_in_at timestamptz not null,
  check_out_at timestamptz not null,
  final_room_charge_vnd integer not null default 0,
  discount_amount_vnd integer not null default 0,
  security_deposit_vnd integer not null default 500000,
  amount_paid_vnd integer not null default 0,
  amount_due_vnd integer not null default 0,
  refund_due_vnd integer not null default 0,
  calculated_commission_vnd integer not null default 0,
  minibar_charges_vnd integer not null default 0,
  damage_charges_vnd integer not null default 0,
  external_channel text,
  external_reservation_id text,
  external_calendar_event_id text,
  sync_status sync_status not null default 'not_synced',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (check_out_at > check_in_at)
);

create index bookings_room_time_idx on bookings (room_id, check_in_at, check_out_at);
create index bookings_sales_agent_idx on bookings (sales_agent_id);

create table booking_holds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  check_in_at timestamptz not null,
  check_out_at timestamptz not null,
  held_until timestamptz not null,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  expired_at timestamptz,
  check (check_out_at > check_in_at)
);

create index booking_holds_room_time_idx on booking_holds (room_id, check_in_at, check_out_at);

create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  amount_vnd integer not null check (amount_vnd >= 0),
  method text not null default 'bank_transfer',
  status payment_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table payment_proofs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  payment_id uuid references payments(id),
  uploaded_by_guest boolean not null default true,
  file_url text not null,
  status proof_status not null default 'uploaded',
  reviewed_by_user_id uuid references users(id),
  reviewed_at timestamptz,
  invalid_reason text,
  created_at timestamptz not null default now()
);

create table discounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope discount_scope not null,
  sales_agent_id uuid references users(id),
  discount_type discount_type not null,
  value_vnd_or_percent numeric(12, 2) not null check (value_vnd_or_percent >= 0),
  is_active boolean not null default true,
  valid_from date,
  valid_until date,
  created_at timestamptz not null default now(),
  check ((scope = 'global' and sales_agent_id is null) or (scope = 'agent_specific' and sales_agent_id is not null))
);

create table agent_commission_rules (
  id uuid primary key default gen_random_uuid(),
  sales_agent_id uuid not null references users(id),
  commission_type commission_type not null,
  value_vnd_or_percent numeric(12, 2) not null check (value_vnd_or_percent >= 0),
  is_active boolean not null default true,
  valid_from date,
  valid_until date,
  created_at timestamptz not null default now()
);

create table minibar_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  unit_price_vnd integer not null check (unit_price_vnd >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table minibar_usage (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  minibar_item_id uuid not null references minibar_items(id),
  cleaning_job_id uuid,
  quantity integer not null check (quantity > 0),
  total_vnd integer not null check (total_vnd >= 0),
  reported_by_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table cleaning_crew_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  fixed_pay_per_job_vnd integer not null default 0 check (fixed_pay_per_job_vnd >= 0),
  jobs_completed integer not null default 0,
  average_rating numeric(3, 2),
  reliability_notes text,
  created_at timestamptz not null default now()
);

create table cleaning_availability (
  id uuid primary key default gen_random_uuid(),
  cleaning_crew_user_id uuid not null references users(id) on delete cascade,
  available_from timestamptz not null,
  available_until timestamptz not null,
  is_active boolean not null default true,
  check (available_until > available_from)
);

create table cleaning_jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  room_id uuid not null references rooms(id),
  assigned_to_user_id uuid references users(id),
  status cleaning_job_status not null default 'assigned',
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  arrived_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  fixed_pay_vnd integer not null default 0,
  damage_charges_vnd integer not null default 0,
  damage_notes text,
  photo_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  check (window_end_at > window_start_at)
);

alter table minibar_usage add constraint minibar_usage_cleaning_job_fk
  foreign key (cleaning_job_id) references cleaning_jobs(id);

create table cleaning_ratings (
  id uuid primary key default gen_random_uuid(),
  cleaning_job_id uuid not null references cleaning_jobs(id) on delete cascade,
  rated_by_user_id uuid not null references users(id),
  rating integer not null check (rating between 1 and 5),
  notes text,
  created_at timestamptz not null default now()
);

create table cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  requested_by_user_id uuid not null references users(id),
  status cancellation_status not null default 'requested',
  reason text,
  cancellation_fee_vnd integer not null default 0,
  approved_by_user_id uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table refund_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  cancellation_request_id uuid references cancellation_requests(id),
  amount_paid_vnd integer not null check (amount_paid_vnd >= 0),
  final_room_charge_vnd integer not null check (final_room_charge_vnd >= 0),
  cancellation_fee_vnd integer not null default 0 check (cancellation_fee_vnd >= 0),
  minibar_charges_vnd integer not null default 0 check (minibar_charges_vnd >= 0),
  damage_charges_vnd integer not null default 0 check (damage_charges_vnd >= 0),
  refund_due_vnd integer not null default 0,
  approved_by_user_id uuid references users(id),
  created_at timestamptz not null default now()
);
