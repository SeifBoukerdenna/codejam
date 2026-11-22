// The story of one invoice, derived from what the API already sends (no extra calls): the five-step pipeline
// at the top of the page and the full "Life of this invoice". Pure functions, so they're easy to read and test.

import type { Email, InvoiceDetail as Data } from "../api";
import { APPROVER_ROLE, INVOICE_STATUS, METHOD, dateTime, instant, longDate, money, senderName, shortDate, statusOf } from "../format";

export type StepState = "done" | "current" | "blocked" | "todo";
export type PipelineStep = { key: string; label: string; state: StepState; sub: string };

const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];

export function statusSentence(d: Data, today: string, me?: string | null): string {
  const inv = d.invoice;
  const pay = d.payments.filter((p) => p.status !== "cancelled").at(-1);
  const method = pay ? (METHOD[pay.method] ?? pay.method).toLowerCase() : "";
  switch (inv.status) {
    case "paid":
      if (inv.is_credit_note) return "Deducted from a payment to this vendor";
      if (!pay) return "Paid";
      if (pay.status === "outstanding") return `Cheque sent ${shortDate(pay.paid_date, today)}, not cashed yet`;
      return `Paid ${shortDate(pay.paid_date, today)} by ${method}`;
    case "scheduled":
      if (!pay) return "Payment scheduled";
      if (pay.status === "held") return "Payment on hold";
      if (pay.status === "prepared") return "Waiting for a finance manager to release it";
      if (pay.status === "released" && pay.method === "CARD") return `Card sent to ${inv.vendor_name}, waiting for their charge`;
      if (pay.status === "released") return `Sent by ${method}, waiting for the bank`;
      return `Scheduled for ${shortDate(pay.scheduled_date, today)}`;
    case "rejected": {
      const r = d.approvals.find((a) => a.action === "rejected");
      return r ? `Declined by ${r.approver_name}` : "Rejected";
    }
    case "pending_approval": {
      const p = d.approvals.find((a) => a.action === "pending");
      return p ? (p.approver_user_id === me ? "Waiting for you" : `Waiting for ${p.approver_name}`) : "Waiting for approval";
    }
    case "approved": return inv.is_credit_note ? "Will be deducted from the next payment" : "Approved, ready to pay";
    case "on_hold": return "Blocked until the problems below are fixed";
    case "needs_review": return "Needs a person before it goes for approval";
    default: return statusOf(INVOICE_STATUS, inv.status).label;
  }
}

/** Received → Read → Checked → Approved → Paid: each step's state, when, and by whom (or why it's stuck). */
export function pipelineSteps(d: Data, email: Email | null | undefined, today: string): PipelineStep[] {
  const inv = d.invoice;
  const x = d.extraction;
  const history = inv.source === "history";
  const created = d.history.find((e) => e.action === "invoice.create");
  const blocks = d.checks.filter((c) => c.severity === "block");
  const warnings = d.checks.filter((c) => c.severity === "warn" && !c.acknowledged_by);
  const passed = d.checks.filter((c) => c.severity === "info").length;
  const pay = d.payments.filter((p) => p.status !== "cancelled").at(-1);

  const received: PipelineStep = email
    ? { key: "received", label: "Received", state: "done", sub: `${dateTime(email.received_at, today)} · ${senderName(email.from_name, email.from_address)}` }
    : x ? { key: "received", label: "Received", state: "done", sub: `${instant(x.received_at)} · uploaded` }
      : { key: "received", label: "Received", state: "done", sub: inv.received_date ? longDate(inv.received_date) : "Before this app" };

  const read: PipelineStep = history
    ? { key: "read", label: "Read", state: "done", sub: "From the dataset's history" }
    : inv.status === "extracting" ? { key: "read", label: "Read", state: "current", sub: "The worker is reading it" }
      : { key: "read", label: "Read", state: "done",
          sub: `${created ? instant(created.created_at) : ""} · ${x?.engine === "tesseract" ? "OCR, 3 passes" : "PDF text"}${x?.doubtful.length ? ` · ${x.doubtful.length} to confirm` : ""}` };

  let checked: PipelineStep;
  if (history) checked = { key: "checked", label: "Checked", state: "done", sub: d.audit_notes.length ? "The audit found a problem" : "Before this app" };
  else if (inv.status === "extracting") checked = { key: "checked", label: "Checked", state: "todo", sub: "After reading" };
  else if (inv.status === "on_hold" && blocks.length) checked = { key: "checked", label: "Checked", state: "blocked", sub: firstSentence(blocks[0].message) };
  else if (inv.status === "needs_review") {
    checked = { key: "checked", label: "Checked", state: "current",
      sub: warnings.length ? firstSentence(warnings[0].message) : d.review_reasons[0] ?? "Needs a person" };
  } else checked = { key: "checked", label: "Checked", state: inv.status === "rejected" && !d.approvals.length ? "blocked" : "done",
    sub: `${passed} passed · ${inv.reviewed_by_name ? `reviewed by ${inv.reviewed_by_name}` : "no person needed"}` };

  const pending = d.approvals.find((s) => s.action === "pending");
  const declined = d.approvals.find((s) => s.action === "rejected");
  const approvedSteps = d.approvals.filter((s) => s.action === "approved");
  let approved: PipelineStep;
  if (declined) approved = { key: "approved", label: "Approved", state: "blocked", sub: `Declined by ${declined.approver_name}` };
  else if (pending) approved = { key: "approved", label: "Approved", state: "current",
    sub: `Waiting for ${pending.approver_name}${pending.on_behalf_of_name ? ` (for ${pending.on_behalf_of_name})` : ""} · step ${pending.step_no} of ${d.approvals.length}` };
  else if (approvedSteps.length) approved = { key: "approved", label: "Approved", state: "done",
    sub: `${approvedSteps.map((s) => s.approver_name).join(", ")} · ${dateTime(approvedSteps.at(-1)!.acted_at, today)}` };
  else approved = { key: "approved", label: "Approved", state: "todo", sub: inv.status === "rejected" ? "Rejected" : "After the checks" };

  let paid: PipelineStep;
  if (inv.is_credit_note && inv.status === "paid") paid = { key: "paid", label: "Paid", state: "done", sub: "Deducted from a payment" };
  else if (!pay) paid = { key: "paid", label: "Paid", state: inv.status === "approved" ? "current" : "todo",
    sub: inv.status === "approved" ? "Ready to pay" : inv.status === "rejected" ? "Won't be paid" : "After approval" };
  else if (pay.status === "settled") paid = { key: "paid", label: "Paid", state: "done",
    sub: `${shortDate(pay.paid_date, today)} · ${(METHOD[pay.method] ?? pay.method).toLowerCase()}` };
  else if (pay.status === "held") paid = { key: "paid", label: "Paid", state: "blocked", sub: pay.hold_reason ? firstSentence(pay.hold_reason) : "On hold" };
  else paid = { key: "paid", label: "Paid", state: "current",
    sub: pay.status === "prepared" ? "Waiting for release" : pay.status === "outstanding" ? "Cheque not cashed yet"
      : pay.status === "released" ? (pay.method === "CARD" ? "Card sent, waiting for the charge" : "Sent, waiting for the bank")
        : `Scheduled for ${shortDate(pay.scheduled_date, today)}` };

  return [received, read, checked, approved, paid];
}

export type LifeEvent = { key: string; title: string; sub: string; note?: string; tone?: "positive" | "negative" | "pending" };

const EVENT_WORDS: Record<string, string> = {
  "invoice.submit": "Sent for approval", "invoice.edit": "Corrected by a person", "invoice.recode": "Ledger account changed",
  "invoice.acknowledge_warning": "Warning checked by a person", "invoice.on_hold": "Put on hold",
  "invoice.needs_review": "Sent to a person", "invoice.reject": "Rejected", "invoice.withdraw_from_approval": "Taken back from approval",
  "payment.prepare": "Payment prepared", "payment.hold": "Payment held", "payment.unhold": "Hold lifted",
  "payment.release": "Payment released", "payment.settle": "Payment confirmed", "payment.cancel": "Payment stopped",
  "card.issued": "Single-use card sent", "card.charge_approved": "Card charge approved", "card.charge_declined": "Card charge declined",
  "credit_note.applied": "Credit note deducted",
};
const FIELD_WORDS: Record<string, string> = {
  vendor_invoice_number: "invoice number", invoice_date: "invoice date", due_date: "due date", total_cents: "total",
  subtotal_cents: "subtotal", gst_hst_cents: "GST/HST", pst_qst_cents: "PST/QST", vendor_gst: "GST number",
  bank_institution: "institution", bank_transit: "transit", bank_account: "account", gl_account: "ledger account",
  department_id: "department", ship_to_province: "delivered to",
};

/** "transit: $5541 → 55541", only for the fields a person changed. */
function beforeAfter(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string | undefined {
  if (!after) return undefined;
  const show = (k: string, v: unknown) => (v === null || v === undefined ? "—" : k.endsWith("_cents") ? money(v as number) : String(v));
  const parts = Object.keys(after).filter((k) => k in FIELD_WORDS)
    .map((k) => `${FIELD_WORDS[k]}: ${show(k, before?.[k])} → ${show(k, after[k])}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Every step from the email to the bank statement, in the order it happened. */
export function lifeEvents(d: Data, email: Email | null | undefined, today: string): LifeEvent[] {
  const inv = d.invoice;
  const x = d.extraction;
  const out: LifeEvent[] = [];

  if (email) out.push({ key: "email", title: `Email from ${senderName(email.from_name, email.from_address)}`,
    sub: dateTime(email.received_at, today), note: `“${email.subject}”` });
  else if (x) out.push({ key: "upload", title: "Uploaded", sub: instant(x.received_at) });
  else if (inv.received_date) out.push({ key: "received", title: "Received", sub: longDate(inv.received_date) });

  const created = d.history.find((e) => e.action === "invoice.create");
  if (x) {
    const disputed = x.field_sources.filter((s) => s.ocr_readings && new Set(s.ocr_readings.map(String)).size > 1)
      .map((s) => `${s.field.replace(/_/g, " ")}: ${s.ocr_readings!.map((r) => `“${r ?? "nothing"}”`).join(", ")}`);
    out.push({ key: "read", title: `Read by the worker from ${x.filename}`, sub: created ? instant(created.created_at) : instant(x.read_at),
      note: x.engine === "tesseract"
        ? `A scan: 3 OCR passes were compared.${disputed.length ? ` They disagreed on ${disputed.join("; ")}.` : " They agreed."}`
        : "From the PDF's own text: exact characters, no OCR needed." });
  }

  // History invoices (from the dataset): the approvals and payments, rebuilt from their own tables.
  const appPayments = new Set(d.history.flatMap((e) => [e.entity_type === "payment" ? e.entity_id : null,
    (e.after as { payment_id?: string } | null)?.payment_id ?? null]));
  if (inv.source === "history") {
    for (const s of d.approvals) {
      out.push({ key: s.approval_id, title: `${s.action === "approved" ? "Approved" : "Declined"} by ${s.approver_name}`,
        sub: `${APPROVER_ROLE[s.approver_role] ?? s.approver_role} · ${dateTime(s.acted_at, today)}`,
        tone: s.action === "approved" ? undefined : "negative", note: s.comment ?? undefined });
    }
    for (const p of d.payments.filter((p) => !appPayments.has(p.payment_id))) {
      out.push({ key: p.payment_id, title: p.status === "settled" ? `Paid by ${(METHOD[p.method] ?? p.method).toLowerCase()}` : `Payment ${p.status}`,
        sub: `${shortDate(p.paid_date ?? p.scheduled_date, today)} · ${p.payment_id}`, tone: p.status === "settled" ? "positive" : undefined });
    }
  }

  // Everything done in the app, from the signed audit log: who, on whose behalf, what changed, and why.
  const stepByNo = new Map(d.approvals.map((s) => [s.step_no, s]));
  for (const e of d.history) {
    if (["invoice.create", "invoice.fully_approved", "invoice.rejected"].includes(e.action)) continue;
    if (e.action === "invoice.approve" || e.action === "invoice.decline") {
      const s = stepByNo.get(Number((e.after as { step?: number } | null)?.step));
      out.push({ key: `e${e.event_id}`, title: `${e.action === "invoice.approve" ? "Approved" : "Declined"} by ${e.actor_name}`,
        sub: [s && (APPROVER_ROLE[s.approver_role] ?? s.approver_role), e.on_behalf_of_name && `on behalf of ${e.on_behalf_of_name}`,
          instant(e.created_at)].filter(Boolean).join(" · "),
        tone: e.action === "invoice.approve" ? undefined : "negative", note: e.reason ?? undefined });
      continue;
    }
    out.push({ key: `e${e.event_id}`, title: `${EVENT_WORDS[e.action] ?? e.action.replace(/[._]/g, " ")}${e.actor_name ? ` · ${e.actor_name}` : ""}`,
      sub: instant(e.created_at),
      tone: e.action.includes("hold") || e.action === "card.charge_declined" ? "negative" : e.action === "payment.settle" || e.action === "card.charge_approved" ? "positive" : undefined,
      note: beforeAfter(e.before, e.after) ?? e.reason ?? undefined });
  }

  if (d.bank_line) {
    out.push({ key: "bank", title: "On the bank statement", sub: longDate(d.bank_line.posted_date),
      note: `${d.bank_line.description} · ${money(d.bank_line.amount_cents)} · ${d.bank_line.kind === "matched" ? "matches our payment" : d.bank_line.explanation}`,
      tone: d.bank_line.kind === "matched" ? "positive" : "negative" });
  } else if (d.in_transit) {
    out.push({ key: "transit", title: "Not on the bank statement yet", sub: "In transit", note: "Paid in the last few days; it will show up on the next statement.", tone: "pending" });
  }
  return out;
}
