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

/** POST/PATCH/upload. Errors come back with the server's reason (e.g. "You approved this invoice, so you
 *  can't release its payment (P11)"), which the UI shows as-is. */
export async function send<T = unknown>(method: "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const isFile = body instanceof FormData;
  return api<T>(path, {
    method,
    body: body === undefined ? undefined : isFile ? body : JSON.stringify(body),
    headers: isFile || body === undefined ? undefined : { "Content-Type": "application/json" },
  });
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
  credit_applied_cents: number;
  // Why the amount differs from the invoice (credit notes deducted), from breakdowns.py.
  breakdown?: Breakdown | null;
  reference: string | null;
  hold_reason: string | null;
};

export type MonthTotal = { month: string; count: number; total_cad_cents: number };

export type HomeData = {
  today: string;
  paid_this_year_cad_cents: number;
  paid_this_year_breakdown: Breakdown;
  payments_this_year: number;
  paid_by_month: MonthTotal[];
  paid_daily: { date: string; total_cad_cents: number; count: number }[];
  /** Running total for every day from Jan 1 to today, computed by the API. */
  paid_running: { date: string; cents: number }[];
  paid_change: Record<"1M" | "3M", number>;
  bank_in_question_cents: number;
  bank_in_question_breakdown: Breakdown;
  bank_waiting: boolean;
  todo: Record<"bank_to_explain" | "emails_to_sort" | "replies_to_send" | "needs_review" | "on_hold" | "waiting_for_me" | "payments_to_release"
    | "approved_to_pay" | "payments_held", number>;
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
  has_reply?: boolean;
  reply_draft?: string | null;
  answered_by_name?: string | null;
  answered_at?: string | null;
  invoices?: { invoice_id: string; status: string; number: string | null }[];
};

export type Invoice = {
  invoice_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_pay_method?: string | null;
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
  document_id: number | null;
  email_id: string | null;
  reviewed_by_name: string | null;
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
  rule_ids: string | null;
  on_behalf_of_user_id: string | null;
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
  acknowledged_by_name: string | null;
};

export type Permission = { allowed: boolean; reason: string } | null;

export type InvoiceActions = {
  edit: Permission; submit: Permission; recheck: Permission; reject: Permission; approve: Permission;
  decline: Permission; prepare_payment: Permission; release: Permission; settle: Permission; charge_card?: Permission;
  cancel_payment: Permission; recheck_payment: Permission; payment_id: string | null;
};

export type FieldConfidence = Record<string, { score: number | null; note: string }>;

export type Extraction = {
  engine: "text_layer" | "tesseract";
  fields: Record<string, unknown> & { vendor_name?: string; vendor_gst?: string; bank_institution?: string;
    bank_transit?: string; bank_account?: string; language?: string; taxes?: { label: string; rate_pct: string }[] };
  field_confidence: FieldConfidence;
  field_sources: FieldSource[];
  filename: string;
  document_id: number;
  mime_type: string;
  received_at: string;
  read_at: string;
  overall: number;
  doubtful: string[];
};

/** Where on page 1 a field was read, as fractions of the page (0–1). `ocr_readings` when the OCR passes disagreed. */
export type FieldSource = {
  field: string; page: number; x0: number; y0: number; x1: number; y1: number;
  source: "text_layer" | "ocr"; ocr_readings?: (string | null)[];
};

export type BankStatementLine = { bank_txn_id: string; posted_date: string; description: string; amount_cents: number;
  kind: string; title: string; explanation: string };

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
  hash?: string;   // this event's signature in the audit chain (hex)
};

export type ChainCheck = { ok: boolean; checked: number; first_bad_event_id: number | null; reason: string; head?: string };

export type InvoiceDetail = {
  invoice: Invoice;
  lines: InvoiceLine[];
  approvals: Approval[];
  payments: Payment[];
  checks: CheckResult[];
  history: AuditEvent[];
  extraction: Extraction | null;
  audit_notes: string[];
  review_reasons: string[];
  actions: InvoiceActions;
  po: { po_id: string; description: string; total_amount_cents: number } | null;
  contract: { contract_id: string; description: string } | null;
  card: VirtualCard | null;
  card_attempts: CardAttempt[];
  bank_line: BankStatementLine | null;
  math: InvoiceMath;
  in_transit: boolean;
};

export type VirtualCard = {
  card_id: string;
  payment_id: string;
  vendor_name: string;
  last4: string;
  expires_on: string;
  limit_cents: number;
  currency: string;
  status: "active" | "used" | "cancelled";
  sent_to: string | null;
  issued_at: string;
};

export type CardAttempt = {
  auth_id: number;
  attempted_at: string;
  merchant: string;
  amount_cents: number;
  approved: boolean;
  reason: string;
  recorded_by_name: string | null;
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

export type SimilarVendor = {
  vendor_id: string; legal_name: string; status: string; kind: "duplicate" | "lookalike"; reasons: string[];
  payments: number;
};

export type InvoiceRow = {
  invoice_id: string; vendor_id: string | null; vendor_name: string | null; vendor_invoice_number: string | null;
  invoice_date: string | null; status: string; currency: string; total_cents: number | null;
  total_cad_cents: number | null; hold_reason: string | null; is_credit_note: boolean; source: string;
};

export type DoublePayment = {
  key: string;
  kind: "paid_twice" | "about_to_pay_twice" | "paid_by_ap_and_card";
  vendor_id: string;
  vendor_name: string;
  invoice_number: string;
  invoice_ids: string[];
  payment_ids: string[];
  lines: { ref: string; date: string | null; method: string; amount_cad_cents: number; status: string }[];
  overpaid_cad_cents: number;
  message: string;
};

export type Recovery = DoublePayment & {
  vendor_email: string | null;
  can_update: Permission;
  status: "to_recover" | "requested" | "recovered";
  requested_by_name: string | null;
  requested_at: string | null;
  recovered_by_name: string | null;
  recovered_at: string | null;
  letter: string;
};

export type TaxAtRisk = {
  invoice_id: string;
  vendor_invoice_number: string | null;
  vendor_name: string | null;
  status: string;
  currency: string;
  code: string;
  message: string;
  fix: string;
  at_risk_cents: number;
};

export type Findings = {
  self_approvals: { invoice_id: string; approver_user_id: string; full_name: string; acted_at: string;
    total_cad_cents: number; vendor_name: string }[];
  double_payments: DoublePayment[];
  overpaid_cad_cents: number;
  recovered_cad_cents: number;
  to_recover_cad_cents: number;
  to_recover_breakdown: Breakdown;
  overpaid_breakdown: Breakdown;
  tax_at_risk_breakdown: Breakdown;
  to_recover_count: number;
  split_invoices: { vendor_name: string; invoice_ids: string[]; combined_cad_cents: number; message: string }[];
  recovery_totals: Record<"to_recover" | "requested" | "recovered", number>;
  tax_at_risk: TaxAtRisk[];
  tax_at_risk_cents: number;
  tax_invoice_count: number;
  tax_by_problem: { code: string; cents: number }[];
};

export type BankLine = {
  bank_txn_id: string;
  posted_date: string;
  description: string;
  amount_cents: number;
  at_stake_cents: number;
  kind: "matched" | "cheque_cashed" | "amount_differs" | "bank_fee" | "fee_without_cause" | "unknown_debit" | "unmatched";
  title: string;
  tone: "positive" | "warning" | "negative";
  explanation: string;
  todo: "ask_bank" | "book_fee" | "mark_cashed" | null;
  resolution: "asked_bank" | "fee_booked" | "cheque_cashed" | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  payment_id: string | null;
  invoice_id: string | null;
  vendor_name: string | null;
};

export type BankPage = {
  lines: BankLine[];
  statement_from: string;
  statement_to: string;
  matched: number;
  to_explain: number;
  unexplained_cents: number;
  waiting_cents: number;
  missing_from_statement: { payment_id: string; invoice_id: string; vendor_name: string; amount_cents: number; paid_date: string }[];
  letter: string;
  bank_fee_account: string;
  todo_totals: Record<"ask_bank" | "book_fee" | "mark_cashed", { count: number; cents: number }>;
  in_question_cents: number;
  in_question_breakdown: Breakdown;
  can_act: { allowed: boolean; reason: string | null };
};

export type FoolResult = "reading" | "caught" | "got_through" | "unreadable";

export type FoolAttempt = {
  id: string;
  kind: "invoice" | "bank_change";
  scenario: string | null;
  title: string;
  created_at: string;
  by_name: string | null;
  result: FoolResult;
  reasons: string[];
  invoice_id?: string | null;
  invoice_ids?: (string | null)[];
  invoice_status?: string | null;
  vendor_id?: string;
  vendor_name: string | null;
  invoice_number?: string | null;
  total_cents?: number | null;
  currency?: string | null;
  document_id?: number;
};

export type FoolPage = {
  scenarios: { key: string; title: string; pitch: string; defense: string }[];
  attempts: FoolAttempt[];
  caught: number;
  finished: number;
  can_try: { allowed: boolean; reason: string | null };
  samples: { document_id: number; filename: string; vendor_name: string; total_cents: number; currency: string }[];
};

export type Reference = {
  departments: { department_id: string; name: string }[];
  gl_accounts: { account_number: string; name: string }[];
  users: { user_id: string; full_name: string; title: string }[];
  vendors: { vendor_id: string; legal_name: string; status: string }[];
  categories: string[];
};

export type VendorDetail = {
  similar: SimilarVendor[];
  lookalike_of: SimilarVendor | null;
  actions: { approve: Permission; hold: Permission; release_hold: Permission; request_bank_change: Permission };
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
    status_reason: string | null;
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
    pending: boolean;
    callback_by_name: string | null;
    callback_phone: string | null;
    callback_outcome: string | null;
    verify: Permission;
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
  remaining_cents: number;
  breakdown: Breakdown;
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

export type MyApprovals = { items: MyApproval[]; total_cad_cents: number };

export type PaymentsPage = {
  payments: PaymentRow[];
  summary: Record<string, { count: number; total_cad_cents: number; next_date: string | null }>;
  tabs: Record<"approved" | "prepared" | "held" | "going" | "outstanding" | "settled", { count: number; total_cad_cents: number }>;
  going_out: { count: number; total_cad_cents: number };
  about_to_pay_twice: DoublePayment[];
};

/** Cmd+K search results (GET /search?q=). */
export type SearchInvoice = {
  invoice_id: string; vendor_id: string | null; vendor_name: string | null; vendor_invoice_number: string | null;
  invoice_date: string | null; status: string; currency: string; total_cents: number | null; total_cad_cents: number | null;
  is_credit_note: boolean;
};
export type SearchVendor = { vendor_id: string; legal_name: string; status: string; category: string; gst_hst_number: string | null;
  lookalike_of: string | null };
export type SearchResults = { invoices: SearchInvoice[]; vendors: SearchVendor[] };

/** "Show the math": parts that add up to the number shown, built on the server (breakdowns.py). When a printed
 *  number doesn't add up, the gap is one of the parts, so the arithmetic on screen is always true. */
export type Breakdown = {
  parts: { label: string; cents: number }[];
  total_label?: string;
  total_cents?: number;
  note?: string | null;
};
export type InvoiceMath = {
  lines: Record<string, Breakdown>;
  taxes: { gst_hst?: Breakdown; pst_qst?: Breakdown };
  subtotal: Breakdown | null;
  total: Breakdown | null;
  po: Breakdown | null;
  po_id: string | null;
};

/** GET /health/slis: the system health page (backend/app/health.py). */
export type Objective = {
  name: "read" | "wait" | "audit"; sentence: string; objective: number; good: number | null; total: number; bad: number;
  actual: number | null; met: boolean; budget_allowed: number; budget_left: number | null; bad_example: string | null;
};
export type Latency = { count: number; p50: number | null; p95: number | null; max: number | null };
export type HealthReport = {
  measured_at: string;
  window_days: number;
  objectives: Objective[];
  queue: {
    waiting: number; oldest_wait_seconds: number | null; stale_after_seconds: number;
    running: { job_id: number; document_id: number; worker_id: string; running_seconds: number; attempts: number; stale: boolean }[];
  };
  latency: { text_layer: Latency; tesseract: Latency };
  touchless: { read: number; touchless: number; rate: number | null };
  confidence: { fields: number; bands: { label: string; from: number; count: number }[] };
  failures_24h: { job_id: number; document_id: number; filename: string; error: string; attempts: number; finished_at: string }[];
  workers: { worker_id: string; jobs: number; last_seen: string }[];
  audit: { ok: boolean; checked: number; reason: string; head?: string };
};
