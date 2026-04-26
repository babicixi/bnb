alter table bookings
  add column notes text,
  add column source text check (source in ('guest', 'agent', 'admin')),
  add column payment_proof_url text,
  add column guest_source_tag text;

alter table users
  add column password_hash text;
