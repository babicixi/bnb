export type Locale = "en" | "vi";

export const DEFAULT_LOCALE: Locale = "vi";

const dict: Record<string, Record<Locale, string>> = {
  "site.title": {
    en: "Cixi Wanderlust",
    vi: "Cixi Wanderlust",
  },
  "site.tagline": {
    en: "Boutique serviced apartments in Hanoi — book by the hour, the day, or the week.",
    vi: "Căn hộ dịch vụ boutique tại Hà Nội — đặt theo giờ, theo ngày hoặc theo tuần.",
  },
  "nav.home": { en: "Home", vi: "Trang chủ" },
  "nav.lookup": { en: "Find my booking", vi: "Tra cứu đặt phòng" },
  "nav.staff_login": { en: "Staff login", vi: "Đăng nhập nhân viên" },
  "nav.logout": { en: "Logout", vi: "Đăng xuất" },

  "rooms.heading": { en: "Our rooms", vi: "Phòng của chúng tôi" },
  "rooms.book_now": { en: "Book this room", vi: "Đặt phòng này" },

  "landing.browse_rooms": { en: "Browse rooms", vi: "Xem phòng" },
  "landing.find_booking": { en: "Find my booking", vi: "Tra cứu đặt phòng" },
  "landing.intro": {
    en: "Hand-picked spaces across our buildings — from cozy studios to family suites.",
    vi: "Những không gian được chọn lọc tại các tòa nhà của chúng tôi — từ studio ấm cúng đến căn suite gia đình.",
  },
  "landing.from_per_night": { en: "from {0}/night", vi: "từ {0}/đêm" },
  "landing.or_per_hour": { en: "or {0}/hour", vi: "hoặc {0}/giờ" },
  "landing.guests_up_to": {
    en: "Up to {0} guests",
    vi: "Tối đa {0} khách",
  },
  "landing.room_number": { en: "room {0}", vi: "phòng {0}" },
  "landing.more_features": {
    en: "+{0} more",
    vi: "+{0} tiện ích khác",
  },
  "landing.talk_heading": { en: "Talk to us", vi: "Liên hệ với chúng tôi" },
  "landing.talk_lede": {
    en: "Questions about rooms, dates, or special requests? Pick whichever channel you use most.",
    vi: "Có câu hỏi về phòng, ngày đặt hay yêu cầu đặc biệt? Chọn kênh bạn dùng nhiều nhất.",
  },
  "landing.fb_message": { en: "Message us on Facebook", vi: "Nhắn tin Facebook" },
  "landing.ig_message": { en: "DM us on Instagram", vi: "Nhắn tin Instagram" },
  "landing.tt_watch": { en: "Watch us on TikTok", vi: "Theo dõi TikTok" },
  "landing.call_reservations": {
    en: "Call Reservations",
    vi: "Gọi đặt phòng",
  },
  "landing.call_cs": { en: "Call Customer Service", vi: "Gọi chăm sóc khách hàng" },
  "landing.reservations_label": { en: "Reservations", vi: "Đặt phòng" },
  "landing.cs_label": { en: "Customer service", vi: "Chăm sóc khách hàng" },
  "landing.fb_heading": {
    en: "Latest from our Facebook page",
    vi: "Cập nhật mới từ Facebook",
  },
  "landing.fb_blurb": {
    en: "Recent rooms, guest moments, and seasonal promotions — straight from facebook.com/cixi.serviceapartments.",
    vi: "Phòng mới, khoảnh khắc khách lưu trú và khuyến mãi theo mùa — từ facebook.com/cixi.serviceapartments.",
  },
  "landing.fb_visit": {
    en: "Visit our Facebook page",
    vi: "Truy cập trang Facebook",
  },
  "landing.fb_also": { en: "Also on", vi: "Theo dõi tại" },

  "room.about": { en: "About this place", vi: "Về căn hộ" },
  "room.features": { en: "Features", vi: "Tiện ích" },
  "room.reserve": { en: "Reserve", vi: "Đặt giữ chỗ" },
  "room.your_details": { en: "Your details", vi: "Thông tin của bạn" },
  "room.nightly_only": {
    en: "Nightly stays only. Pick different dates for check-in and check-out.",
    vi: "Chỉ nhận đặt theo đêm. Chọn ngày nhận và trả phòng khác nhau.",
  },
  "room.standard_checkin": { en: "Standard check-in", vi: "Giờ nhận tiêu chuẩn" },
  "room.standard_checkout": {
    en: "Standard check-out",
    vi: "Giờ trả tiêu chuẩn",
  },
  "room.late_checkout": {
    en: "Late check-out",
    vi: "Trả phòng muộn",
  },
  "room.late_rules": {
    en: "11:00–12:00 free · 12:00–14:00 = 2h tier · 14:00–16:00 = 4h tier · 16:00–18:00 = 6h tier (rounded up). After 18:00 = extra full day.",
    vi: "11:00–12:00 miễn phí · 12:00–14:00 = mức 2h · 14:00–16:00 = mức 4h · 16:00–18:00 = mức 6h (làm tròn lên). Sau 18:00 = tính thêm 1 ngày.",
  },
  "room.detect_rules": {
    en: "Same day → hourly · different days → day / multi-day. Day & multi-day check-in must be at or after 14:00.",
    vi: "Cùng ngày → tính theo giờ · khác ngày → tính theo ngày / nhiều ngày. Đặt ngày phải nhận phòng từ 14:00 trở đi.",
  },
  "room.checking": { en: "Checking availability…", vi: "Đang kiểm tra phòng trống…" },
  "room.pick_dates": {
    en: "Pick check-in and check-out to see availability.",
    vi: "Chọn ngày nhận và trả phòng để xem tình trạng còn trống.",
  },
  "room.available": {
    en: "Available · {0} rate · total to collect: {1}",
    vi: "Còn phòng · giá {0} · tổng cần thanh toán: {1}",
  },
  "room.late_fee": { en: "late check-out fee: {0}", vi: "phí trả muộn: {0}" },
  "room.unavailable": { en: "Not available.", vi: "Đã có người đặt." },

  "booking.checkin": { en: "Check-in", vi: "Nhận phòng" },
  "booking.checkout": { en: "Check-out", vi: "Trả phòng" },
  "booking.type": { en: "Booking type", vi: "Loại đặt phòng" },
  "booking.search": { en: "Check availability", vi: "Kiểm tra phòng trống" },
  "booking.guest_name": { en: "Full name", vi: "Họ và tên" },
  "booking.phone": { en: "Phone", vi: "Số điện thoại" },
  "booking.email": { en: "Email (optional)", vi: "Email (không bắt buộc)" },
  "booking.notes": { en: "Notes (optional)", vi: "Ghi chú (không bắt buộc)" },
  "booking.confirm": { en: "Hold for 15 minutes", vi: "Giữ chỗ 15 phút" },
  "booking.reserve": {
    en: "Reserve — please upload the bank-transfer screenshot within 15 minutes",
    vi: "Đặt giữ chỗ — vui lòng tải ảnh chuyển khoản trong 15 phút",
  },
  "booking.checkin_date": { en: "Check-in date", vi: "Ngày nhận phòng" },
  "booking.checkin_time": { en: "Check-in time (24h)", vi: "Giờ nhận phòng (24h)" },
  "booking.checkout_date": { en: "Check-out date", vi: "Ngày trả phòng" },
  "booking.checkout_time": { en: "Check-out time (24h)", vi: "Giờ trả phòng (24h)" },
  "booking.email_required": { en: "Email", vi: "Email" },
  "booking.facebook": { en: "Facebook (optional)", vi: "Facebook (không bắt buộc)" },
  "booking.instagram": { en: "Instagram (optional)", vi: "Instagram (không bắt buộc)" },
  "booking.upload_proof": {
    en: "Upload bank transfer screenshot",
    vi: "Tải lên ảnh chụp chuyển khoản",
  },
  "booking.confirmation": {
    en: "Booking confirmed",
    vi: "Đặt phòng đã xác nhận",
  },
  "booking.bank_label": {
    en: "Please transfer the exact amount below to:",
    vi: "Vui lòng chuyển khoản đúng số tiền dưới đây đến:",
  },
  "booking.bank_note": {
    en: 'Use the booking number {0} as the transfer reference so we can match your payment automatically. Then upload the bank-transfer screenshot below.',
    vi: 'Vui lòng ghi mã đặt phòng {0} trong nội dung chuyển khoản để chúng tôi đối soát tự động. Sau đó tải ảnh chụp giao dịch lên dưới đây.',
  },

  "footer.brand_line": {
    en: "© {0} Cixi Wanderlust · Hanoi",
    vi: "© {0} Cixi Wanderlust · Hà Nội",
  },
  "footer.find_reservation": {
    en: "Find your reservation",
    vi: "Tra cứu đặt phòng",
  },

  "lookup.heading": { en: "Find my booking", vi: "Tra cứu đặt phòng" },
};

function interpolate(template: string, args: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (_, idx) => {
    const v = args[Number(idx)];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function t(
  key: string,
  locale: Locale = DEFAULT_LOCALE,
  ...args: unknown[]
): string {
  const entry = dict[key];
  if (!entry) return key;
  const template = entry[locale] ?? entry.en;
  return args.length > 0 ? interpolate(template, args) : template;
}
