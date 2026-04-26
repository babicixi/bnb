import type {
  Booking,
  BookingGuestView,
  Guest,
  User,
} from "../domain/types.js";

export function canEditBooking(user: User, booking: Booking): boolean {
  if (user.role === "admin" || user.role === "manager") return true;
  return user.role === "sales_agent" && booking.salesAgentId === user.id;
}

export function canApproveCancellation(user: User): boolean {
  return user.role === "admin" || user.role === "manager";
}

export function bookingGuestViewForUser(
  user: User,
  booking: Booking,
  guest: Guest,
): BookingGuestView {
  const base: BookingGuestView = {
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    checkInAt: booking.checkInAt,
    checkOutAt: booking.checkOutAt,
  };

  if (
    user.role === "admin" ||
    user.role === "manager" ||
    (user.role === "sales_agent" && booking.salesAgentId === user.id)
  ) {
    return {
      ...base,
      guest: {
        fullName: guest.fullName,
        phone: guest.phone,
        email: guest.email,
      },
    };
  }

  return base;
}
