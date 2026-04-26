insert into roles (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'admin'),
  ('00000000-0000-0000-0000-000000000002', 'manager'),
  ('00000000-0000-0000-0000-000000000003', 'sales_agent'),
  ('00000000-0000-0000-0000-000000000004', 'cleaning_crew');

insert into users (id, role_id, full_name, email, phone) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Admin User', 'admin@example.com', '+84900000001'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Manager User', 'manager@example.com', '+84900000002'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'Sales Agent One', 'agent1@example.com', '+84900000003'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'Sales Agent Two', 'agent2@example.com', '+84900000004'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'Cleaner One', 'cleaner1@example.com', '+84900000005'),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000004', 'Cleaner Two', 'cleaner2@example.com', '+84900000006');

insert into buildings (id, name, address, city, district) values
  ('20000000-0000-0000-0000-000000000001', 'Saigon Central Apartments', '1 Nguyen Hue', 'Ho Chi Minh City', 'District 1');

insert into rooms (id, building_id, name, room_number, max_guests, base_day_rate_vnd, base_hourly_rate_vnd) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Studio Balcony', '101', 2, 900000, 150000),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Deluxe Window', '102', 2, 1100000, 180000),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'Family Suite', '201', 4, 1800000, 250000);

insert into room_media (room_id, url, alt_text, sort_order) values
  ('30000000-0000-0000-0000-000000000001', 'https://example.com/rooms/101-1.jpg', 'Studio Balcony main photo', 1),
  ('30000000-0000-0000-0000-000000000002', 'https://example.com/rooms/102-1.jpg', 'Deluxe Window main photo', 1),
  ('30000000-0000-0000-0000-000000000003', 'https://example.com/rooms/201-1.jpg', 'Family Suite main photo', 1);

insert into room_daily_rates (room_id, rate_date, day_rate_vnd, hourly_rate_vnd) values
  ('30000000-0000-0000-0000-000000000001', '2026-05-01', 900000, 150000),
  ('30000000-0000-0000-0000-000000000001', '2026-05-02', 950000, 150000),
  ('30000000-0000-0000-0000-000000000001', '2026-05-03', 1000000, 160000),
  ('30000000-0000-0000-0000-000000000002', '2026-05-01', 1100000, 180000),
  ('30000000-0000-0000-0000-000000000003', '2026-05-01', 1800000, 250000);

insert into minibar_items (id, name, unit_price_vnd) values
  ('40000000-0000-0000-0000-000000000001', 'Water', 15000),
  ('40000000-0000-0000-0000-000000000002', 'Soft Drink', 25000),
  ('40000000-0000-0000-0000-000000000003', 'Instant Noodles', 30000);

insert into discounts (id, name, scope, sales_agent_id, discount_type, value_vnd_or_percent, is_active, valid_from, valid_until) values
  ('50000000-0000-0000-0000-000000000001', 'Launch 10 Percent', 'global', null, 'percentage', 10, true, '2026-01-01', '2026-12-31'),
  ('50000000-0000-0000-0000-000000000002', 'Agent One 100k', 'agent_specific', '10000000-0000-0000-0000-000000000003', 'fixed', 100000, true, '2026-01-01', '2026-12-31');

insert into agent_commission_rules (id, sales_agent_id, commission_type, value_vnd_or_percent, is_active, valid_from, valid_until) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'percentage', 8, true, '2026-01-01', '2026-12-31'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000004', 'fixed', 120000, true, '2026-01-01', '2026-12-31');

insert into cleaning_crew_profiles (user_id, fixed_pay_per_job_vnd, reliability_notes) values
  ('10000000-0000-0000-0000-000000000005', 120000, 'Prefers District 1 jobs'),
  ('10000000-0000-0000-0000-000000000006', 130000, 'Available most weekends');

insert into cleaning_availability (cleaning_crew_user_id, available_from, available_until) values
  ('10000000-0000-0000-0000-000000000005', '2026-05-02 11:00:00+07', '2026-05-02 17:00:00+07'),
  ('10000000-0000-0000-0000-000000000006', '2026-05-02 12:00:00+07', '2026-05-02 18:00:00+07');
