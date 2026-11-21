// Every request carries the user picked in the switcher as X-User-Id. The server decides what that user may
// do; the UI only hides buttons for convenience, it never enforces anything.

const USER_KEY = "harborline.userId";

export function getStoredUserId(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null; // storage can be blocked (private window); the app then just starts with no user picked
  }
}

export function storeUserId(userId: string): void {
  try {
    localStorage.setItem(USER_KEY, userId);
  } catch {
    // not persisted across reloads, but the in-memory choice still works
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const userId = getStoredUserId();
  if (userId) headers.set("X-User-Id", userId);
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── response shapes (mirror the SQL in backend/app/routes) ──

export type User = {
  user_id: string;
  full_name: string;
  title: string;
  role: string;
  status: string;
  department_id: string;
  department: string;
};

export type PaymentRow = {
  payment_id: string;
  invoice_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_invoice_number: string | null;
  method: string;
  scheduled_date: string | null;
  paid_date: string | null;
  status: string;
  currency: string;
  amount_cents: number;
  amount_cad_cents: number;
  reference: string | null;
  hold_reason: string | null;
};

export type MonthTotal = { month: string; count: number; total_cad_cents: number };

export type HomeData = {
  today: string;
  paid_this_year_cad_cents: number;
  payments_this_year: number;
  paid_by_month: MonthTotal[];
  todo: Record<"emails_to_sort" | "needs_review" | "on_hold" | "waiting_for_me" | "payments_to_release", number>;
  scheduled: { count: number; total_cad_cents: number };
  upcoming: PaymentRow[];
};

export type Email = {
  email_id: string;
  from_name: string | null;
  from_address: string;
  to_address?: string;
  subject: string;
  received_at: string;
  body?: string;
  attachments: string[];
  classification: string | null;
  intake_status: string;
  intake_note: string | null;
};

export type Invoice = {
  invoice_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_status: string | null;
  vendor_category: string | null;
  vendor_invoice_number: string | null;
  invoice_date: string | null;
  received_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal_cents: number | null;
  gst_hst_cents: number | null;
  pst_qst_cents: number | null;
  total_cents: number | null;
  fx_rate_to_cad: number | null;
  total_cad_cents: number | null;
  department_id: string | null;
  department_name: string | null;
  requester_user_id: string | null;
  requester_name: string | null;
  po_id: string | null;
  contract_id: string | null;
  ship_to_province: string | null;
  status: string;
  source: string;
  is_credit_note: boolean;
  hold_reason: string | null;
};

export type InvoiceLine = {
  line_no: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  gl_account: string | null;
  gl_name: string | null;
  department_name: string | null;
  gst_hst_code: string | null;
  pst_qst_code: string | null;
  line_type: string | null;
  coding_reason: string | null;
};

export type Approval = {
  approval_id: string;
  step_no: number;
  approver_user_id: string;
  approver_name: string;
  approver_role: string;
  action: "pending" | "approved" | "rejected";
  acted_at: string | null;
  comment: string | null;
  on_behalf_of_name: string | null;
  routing_note: string | null;
};

export type Payment = PaymentRow & { prepared_by_name: string | null; released_by_name: string | null };

export type CheckResult = {
  check_id: number;
  code: string;
  severity: "block" | "warn" | "info";
  message: string;
  acknowledged_by: string | null;
};

export type AuditEvent = {
  event_id: number;
  actor_user_id: string | null;
  actor_name: string | null;
  on_behalf_of_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
};

export type InvoiceDetail = {
  invoice: Invoice;
  lines: InvoiceLine[];
  approvals: Approval[];
  payments: Payment[];
  checks: CheckResult[];
  history: AuditEvent[];
  po: { po_id: string; description: string; total_amount_cents: number } | null;
  contract: { contract_id: string; description: string } | null;
};

export type VendorRow = {
  vendor_id: string;
  legal_name: string;
  category: string;
  status: string;
  province_or_state: string | null;
  country: string;
  paid_this_year_cad_cents: number;
  invoice_count: number;
  bank_change_unverified: boolean;
};

export type VendorDetail = {
  vendor: VendorRow & {
    address: string | null;
    gst_hst_number: string | null;
    qst_number: string | null;
    payment_terms_days: number | null;
    preferred_payment_method: string | null;
    bank_institution: string | null;
    bank_transit: string | null;
    bank_account_last4: string | null;
    bank_details_updated_at: string | null;
    ap_contact_email: string | null;
    requires_po: boolean;
    default_gl_account: string | null;
  };
  paid_this_year: { cents: number; count: number };
  bank_changes: {
    change_id: string;
    changed_at: string;
    changed_by_name: string | null;
    request_channel: string;
    verified_by_callback: boolean;
    old_account_last4: string | null;
    new_account_last4: string | null;
  }[];
  contracts: {
    contract_id: string;
    description: string;
    billing_type: string;
    monthly_fee_cents: number | null;
    currency: string;
    hourly_rate_cap_cents: number | null;
    fuel_surcharge_cap_pct: number | null;
    not_to_exceed_monthly_cents: number | null;
    end_date: string;
    status: string;
  }[];
  purchase_orders: {
    po_id: string;
    description: string;
    total_amount_cents: number;
    invoiced_cents: number;
    status: string;
    issue_date: string;
  }[];
  invoices: {
    invoice_id: string;
    vendor_invoice_number: string | null;
    invoice_date: string | null;
    status: string;
    currency: string;
    total_cents: number | null;
    is_credit_note: boolean;
  }[];
};

export type MyApproval = {
  approval_id: string;
  invoice_id: string;
  step_no: number;
  approver_role: string;
  routing_note: string | null;
  on_behalf_of_name: string | null;
  vendor_invoice_number: string | null;
  total_cad_cents: number;
  invoice_date: string | null;
  vendor_name: string | null;
};
