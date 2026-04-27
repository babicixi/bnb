import bcrypt from "bcryptjs";
import type { Repository } from "./memory.js";
import { atVietnamTime } from "../domain/time.js";

export interface DemoCredential {
  role: string;
  email: string;
  password: string;
}

export function seedRepository(repo: Repository): DemoCredential[] {
  const passwordsByEmail: DemoCredential[] = [
    { role: "admin", email: "admin@example.com", password: "admin12345" },
    { role: "manager", email: "manager@example.com", password: "manager12345" },
    {
      role: "sales_agent",
      email: "agent1@example.com",
      password: "agent12345",
    },
    {
      role: "sales_agent",
      email: "agent2@example.com",
      password: "agent12345",
    },
    {
      role: "cleaning_crew",
      email: "cleaner1@example.com",
      password: "cleaner12345",
    },
    {
      role: "cleaning_crew",
      email: "cleaner2@example.com",
      password: "cleaner12345",
    },
  ];

  const hashes = new Map<string, string>();
  for (const cred of passwordsByEmail) {
    hashes.set(cred.email, bcrypt.hashSync(cred.password, 8));
  }

  // Users
  const users = [
    {
      id: "admin-1",
      role: "admin" as const,
      fullName: "Admin User",
      email: "admin@example.com",
      phone: "+84900000001",
      isActive: true,
      passwordHash: hashes.get("admin@example.com"),
    },
    {
      id: "manager-1",
      role: "manager" as const,
      fullName: "Manager User",
      email: "manager@example.com",
      phone: "+84900000002",
      isActive: true,
      passwordHash: hashes.get("manager@example.com"),
    },
    {
      id: "agent-1",
      role: "sales_agent" as const,
      fullName: "Sales Agent One",
      email: "agent1@example.com",
      phone: "+84900000003",
      isActive: true,
      passwordHash: hashes.get("agent1@example.com"),
    },
    {
      id: "agent-2",
      role: "sales_agent" as const,
      fullName: "Sales Agent Two",
      email: "agent2@example.com",
      phone: "+84900000004",
      isActive: true,
      passwordHash: hashes.get("agent2@example.com"),
    },
    {
      id: "cleaner-1",
      role: "cleaning_crew" as const,
      fullName: "Cleaner One",
      email: "cleaner1@example.com",
      phone: "+84900000005",
      isActive: true,
      passwordHash: hashes.get("cleaner1@example.com"),
    },
    {
      id: "cleaner-2",
      role: "cleaning_crew" as const,
      fullName: "Cleaner Two",
      email: "cleaner2@example.com",
      phone: "+84900000006",
      isActive: true,
      passwordHash: hashes.get("cleaner2@example.com"),
    },
  ];
  for (const user of users) {
    repo.users.set(user.id, user);
  }

  // Buildings
  repo.buildings.set("building-1", {
    id: "building-1",
    name: "Saigon Central Apartments",
    address: "1 Nguyen Hue",
    city: "Ho Chi Minh City",
    district: "District 1",
  });

  // Rooms
  const rooms = [
    {
      id: "room-1",
      buildingId: "building-1",
      name: "Studio Balcony",
      roomNumber: "101",
      maxGuests: 2,
      baseDayRateVnd: 900_000,
      baseHourlyRateVnd: 150_000,
      isActive: true,
      description: "Cozy studio with private balcony overlooking Nguyen Hue.",
      features: ["Balcony", "Smart TV", "Air conditioning", "Fast Wi-Fi"],
      photoUrls: ["https://placehold.co/600x400?text=Studio+Balcony"],
      videoUrls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      syncStatus: "not_synced" as const,
    },
    {
      id: "room-2",
      buildingId: "building-1",
      name: "Deluxe Window",
      roomNumber: "102",
      maxGuests: 2,
      baseDayRateVnd: 1_100_000,
      baseHourlyRateVnd: 180_000,
      isActive: true,
      description: "Bright deluxe room with city window and small kitchenette.",
      features: ["City window", "Kitchenette", "Bathtub", "Projector"],
      photoUrls: ["https://placehold.co/600x400?text=Deluxe+Window"],
      syncStatus: "not_synced" as const,
    },
    {
      id: "room-3",
      buildingId: "building-1",
      name: "Family Suite",
      roomNumber: "201",
      maxGuests: 4,
      baseDayRateVnd: 1_800_000,
      baseHourlyRateVnd: 250_000,
      isActive: true,
      description: "Two-bedroom suite suitable for families.",
      features: ["Two bedrooms", "Couch", "Smart TV", "Bathtub", "Snacks bar"],
      photoUrls: ["https://placehold.co/600x400?text=Family+Suite"],
      syncStatus: "not_synced" as const,
    },
  ];
  for (const room of rooms) {
    repo.rooms.set(room.id, room);
  }

  // Daily rates (90 days from today, base rates each)
  const today = new Date();
  for (const room of rooms) {
    for (let i = 0; i < 90; i += 1) {
      const date = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + i,
        ),
      );
      repo.rates.push({
        roomId: room.id,
        rateDate: date.toISOString().slice(0, 10),
        dayRateVnd: room.baseDayRateVnd,
        hourlyRateVnd: room.baseHourlyRateVnd,
      });
    }
  }

  // Minibar
  const minibarItems = [
    {
      id: "minibar-water",
      name: "Water",
      unitPriceVnd: 15_000,
      isActive: true,
    },
    {
      id: "minibar-soft-drink",
      name: "Soft Drink",
      unitPriceVnd: 25_000,
      isActive: true,
    },
    {
      id: "minibar-instant-noodles",
      name: "Instant Noodles",
      unitPriceVnd: 30_000,
      isActive: true,
    },
  ];
  for (const item of minibarItems) {
    repo.minibarItems.set(item.id, item);
  }

  // Discounts
  repo.discounts.push(
    {
      id: "discount-launch10",
      name: "Launch 10 Percent",
      scope: "global",
      discountType: "percentage",
      value: 10,
      isActive: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
    {
      id: "discount-agent1-100k",
      name: "Agent One 100k Off",
      scope: "agent_specific",
      salesAgentId: "agent-1",
      discountType: "fixed",
      value: 100_000,
      isActive: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
  );

  // Commission rules
  repo.commissionRules.push(
    {
      id: "commission-agent1",
      salesAgentId: "agent-1",
      commissionType: "percentage",
      value: 8,
      isActive: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
    {
      id: "commission-agent2",
      salesAgentId: "agent-2",
      commissionType: "fixed",
      value: 120_000,
      isActive: true,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
  );

  // Cleaning crew profiles
  repo.cleaningCrewProfiles.set("cleaner-1", {
    userId: "cleaner-1",
    fixedPayPerJobVnd: 120_000,
    jobsCompleted: 0,
    reliabilityNotes: "Prefers District 1 jobs",
  });
  repo.cleaningCrewProfiles.set("cleaner-2", {
    userId: "cleaner-2",
    fixedPayPerJobVnd: 130_000,
    jobsCompleted: 0,
    reliabilityNotes: "Available most weekends",
  });

  // Cleaning availability — broad weekday windows for the next 30 days
  for (let i = 0; i < 30; i += 1) {
    const dateKey = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + i,
      ),
    )
      .toISOString()
      .slice(0, 10);
    repo.cleaningAvailability.push({
      id: `availability-c1-${dateKey}`,
      cleaningCrewUserId: "cleaner-1",
      availableFrom: atVietnamTime(dateKey, 8),
      availableUntil: atVietnamTime(dateKey, 22),
      isActive: true,
    });
    repo.cleaningAvailability.push({
      id: `availability-c2-${dateKey}`,
      cleaningCrewUserId: "cleaner-2",
      availableFrom: atVietnamTime(dateKey, 9),
      availableUntil: atVietnamTime(dateKey, 23),
      isActive: true,
    });
  }

  return passwordsByEmail;
}
