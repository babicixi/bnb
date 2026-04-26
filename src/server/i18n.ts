export type Locale = "en" | "vi";

const dict: Record<string, Record<Locale, string>> = {
  "site.title": {
    en: "Vietnam Short-Stay",
    vi: "Lưu trú ngắn hạn Việt Nam",
  },
  "site.tagline": {
    en: "Apartments & rooms — book in minutes",
    vi: "Căn hộ & phòng — đặt trong vài phút",
  },
  "nav.home": { en: "Home", vi: "Trang chủ" },
  "nav.lookup": { en: "Find my booking", vi: "Tra cứu đặt phòng" },
  "nav.staff_login": { en: "Staff login", vi: "Đăng nhập nhân viên" },
  "nav.logout": { en: "Logout", vi: "Đăng xuất" },
  "rooms.heading": { en: "Our rooms", vi: "Phòng của chúng tôi" },
  "rooms.book_now": { en: "Book this room", vi: "Đặt phòng này" },
  "booking.checkin": { en: "Check-in", vi: "Nhận phòng" },
  "booking.checkout": { en: "Check-out", vi: "Trả phòng" },
  "booking.type": { en: "Booking type", vi: "Loại đặt phòng" },
  "booking.search": { en: "Check availability", vi: "Kiểm tra phòng trống" },
  "booking.guest_name": { en: "Full name", vi: "Họ và tên" },
  "booking.phone": { en: "Phone", vi: "Số điện thoại" },
  "booking.email": { en: "Email (optional)", vi: "Email (không bắt buộc)" },
  "booking.notes": { en: "Notes (optional)", vi: "Ghi chú (không bắt buộc)" },
  "booking.confirm": { en: "Hold for 15 minutes", vi: "Giữ chỗ 15 phút" },
  "booking.upload_proof": {
    en: "Upload bank transfer screenshot",
    vi: "Tải lên ảnh chụp chuyển khoản",
  },
  "booking.confirmation": {
    en: "Booking confirmed",
    vi: "Đặt phòng đã xác nhận",
  },
};

export function t(key: string, locale: Locale = "en"): string {
  const entry = dict[key];
  if (!entry) return key;
  return entry[locale] ?? entry.en;
}
