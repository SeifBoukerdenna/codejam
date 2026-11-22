// Turning API data into words. Money arrives as integer cents; dividing by 100 here is for display only,
// no arithmetic on money ever happens in the browser.

export type Tone = "neutral" | "positive" | "warning" | "negative" | "info";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

/** Sign and digits of an amount in cents, e.g. { sign: "−", amount: "1,614.21" }. Formatting only: the browser
 *  never adds, subtracts or rounds money; it shows what the API computed. */
export function moneyParts(cents: number, compact = false): { sign: string; amount: string } {
  const amount = new Intl.NumberFormat("en-CA", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 2,
    minimumFractionDigits: compact ? 0 : 2,
  }).format(Math.abs(cents) / 100);
  return { sign: cents < 0 ? "−" : "", amount };
}

/** "$3,716.34 CAD", "−$1,614.21 CAD", "$1,950.00 USD": the currency is always written out.
 *  `compact` ("$1.9M") is for chart axes only. */
export function money(cents: number | null | undefined, currency = "CAD", compact = false): string {
  if (cents === null || cents === undefined) return "—";
  const { sign, amount } = moneyParts(cents, compact);
  return compact ? `${sign}$${amount}` : `${sign}$${amount} ${currency}`;
}

// Dates come as "2026-11-02" or "2026-10-20T08:25:00". They are read as plain calendar values (no Date
// object), so a browser in another time zone can never shift an invoice to the previous day.
function parts(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

/** "Nov 2", or "Nov 2, 2025" when it's not the current year. */
export function shortDate(iso: string | null | undefined, today?: string): string {
  if (!iso) return "—";
  const { y, m, d } = parts(iso);
  const sameYear = today ? parts(today).y === y : false;
  return `${MONTHS[m - 1]} ${d}${sameYear ? "" : `, ${y}`}`;
}

/** "November 2, 2026" */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const { y, m, d } = parts(iso);
  return `${MONTHS_LONG[m - 1]} ${d}, ${y}`;
}

/** "Oct 20, 8:25 AM" */
export function dateTime(iso: string | null | undefined, today?: string): string {
  if (!iso) return "—";
  const time = iso.length > 10 ? iso.slice(11, 16) : "";
  if (!time) return shortDate(iso, today);
  const [h, min] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${shortDate(iso, today)}, ${((h + 11) % 12) + 1}:${String(min).padStart(2, "0")} ${ampm}`;
}

export function monthName(yyyyMm: string, long = false): string {
  const m = Number(yyyyMm.slice(5, 7));
  return (long ? MONTHS_LONG : MONTHS)[m - 1];
}

/** "Polar Freight Lines Ltd." -> "PF", "Harlow & Stern LLP" -> "HS" */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  if (/^U\d+$/.test(name)) return name.slice(1);
  const words = name.split(/\s+/).filter((w) => /^[A-Za-zÀ-ÿ]/.test(w) && !/^(and|et|of|the)$/i.test(w));
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

export function firstName(fullName: string): string {
  return fullName.split(" ")[0];
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "Keystone Racking Systems Accounts Receivable" -> "Keystone Racking Systems" */
export function senderName(fromName: string | null, fromAddress: string): string {
  return (fromName ?? fromAddress).replace(/\s+(Accounts Receivable|AR|Billing)$/i, "");
}

type Status = { label: string; tone: Tone };

// One status vocabulary for the whole app, in the order work flows. Same word, same colour, every page:
// amber = a person needs to act, red = blocked, blue = in flow, green = done, grey = nothing to do.
export const INVOICE_STATUS: Record<string, Status> = {
  extracting: { label: "Reading", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warning" },
  on_hold: { label: "On hold", tone: "negative" },
  pending_approval: { label: "Waiting for approval", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  scheduled: { label: "Scheduled", tone: "info" },
  paid: { label: "Paid", tone: "positive" },
  rejected: { label: "Rejected", tone: "negative" },
};

export const PAYMENT_STATUS: Record<string, Status> = {
  prepared: { label: "Waiting for release", tone: "warning" },
  held: { label: "On hold", tone: "negative" },
  released: { label: "Sent", tone: "info" },
  scheduled: { label: "Scheduled", tone: "info" },
  outstanding: { label: "Cheque not cashed", tone: "neutral" },
  settled: { label: "Paid", tone: "positive" },
  cancelled: { label: "Stopped", tone: "neutral" },
};

export const VENDOR_STATUS: Record<string, Status> = {
  active: { label: "Active", tone: "positive" },
  pending_review: { label: "Pending review", tone: "warning" },
  on_hold: { label: "On hold", tone: "negative" },
};

export const METHOD: Record<string, string> = {
  EFT: "Bank transfer",
  CHEQUE: "Cheque",
  CARD: "Virtual card",
};

export const ROLE: Record<string, string> = {
  employee: "Employee",
  ap_clerk: "AP clerk",
  approver: "Department manager",
  finance_manager: "Finance manager",
  controller_admin: "Controller",
  auditor: "Auditor · read-only",
};

export const APPROVER_ROLE: Record<string, string> = {
  dept_manager: "Department manager",
  finance_manager: "Finance manager",
  controller_admin: "Controller",
  cfo: "CFO",
};

export function statusOf(map: Record<string, Status>, key: string): Status {
  return map[key] ?? { label: key.replace(/_/g, " "), tone: "neutral" };
}

/** Audit timestamps are real moments (timestamptz), so unlike invoice dates they ARE converted to the
 *  viewer's local time. "Nov 21, 10:07 a.m." */
export function instant(iso: string): string {
  // en-US for the "6:30 PM" style, the same as dateTime() above, so one page never mixes "PM" and "p.m.".
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(iso));
}

/** For things that just happened on screen: "just now", "4 min ago". Older than a day shows the date. */
export function ago(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return instant(iso);
}

export const PROVINCE: Record<string, string> = {
  ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan",
  NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
};
