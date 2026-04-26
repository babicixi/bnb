// HTML <input type="datetime-local"> sends strings like "2026-05-12T15:00" with
// no timezone. Treat them as Vietnam local time so booking rules work the same
// regardless of where the server runs. Strings already carrying Z or ±HH:MM are
// passed through.
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function parseVietnamLocal(input: string): Date {
  if (NAIVE_DATETIME.test(input)) {
    const seconds = /:\d{2}$/.test(input.slice(-3)) ? "" : ":00";
    return new Date(`${input}${seconds}+07:00`);
  }
  return new Date(input);
}
