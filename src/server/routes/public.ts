import { Router, type Express } from "express";
import type { Repository } from "../../repo/memory.js";

export function mountPublicRoutes(app: Express, repo: Repository): void {
  const router = Router();

  router.get("/", (_req, res) => {
    const buildings = Array.from(repo.buildings.values()).map((b) => ({
      ...b,
      rooms: Array.from(repo.rooms.values()).filter(
        (r) => r.buildingId === b.id && r.isActive,
      ),
    }));
    res.render("home", { title: "Home", buildings });
  });

  router.get("/rooms/:id", (req, res) => {
    const room = repo.rooms.get(req.params.id);
    if (!room) {
      res
        .status(404)
        .render("error", { title: "Not found", message: "Room not found." });
      return;
    }
    const building = repo.buildings.get(room.buildingId);
    res.render("room", { title: room.name, room, building, error: null });
  });

  router.get("/lookup", (_req, res) => {
    res.render("lookup", {
      title: "Find my booking",
      booking: null,
      error: null,
    });
  });

  router.post("/lookup", (req, res) => {
    const number = String(req.body.bookingNumber ?? "").trim();
    const contact = String(req.body.contact ?? "").trim();
    if (!number || !contact) {
      res.status(400).render("lookup", {
        title: "Find my booking",
        booking: null,
        error: "Booking number and your phone or email are required.",
      });
      return;
    }
    const id = repo.bookingsByNumber.get(number);
    const booking = id ? repo.bookings.get(id) : undefined;
    const guest = booking ? repo.guests.get(booking.guestId) : undefined;
    const contactLower = contact.toLowerCase();
    const matches =
      guest &&
      (guest.phone === contact ||
        (guest.email && guest.email.toLowerCase() === contactLower));
    if (!booking || !matches) {
      res.render("lookup", {
        title: "Find my booking",
        booking: null,
        error: "No matching booking.",
      });
      return;
    }
    const room = repo.rooms.get(booking.roomId);
    res.render("lookup", {
      title: "Find my booking",
      booking,
      room,
      guest,
      error: null,
    });
  });

  app.use(router);
}
