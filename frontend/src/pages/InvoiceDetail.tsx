import { Link, useNavigate, useParams } from "react-router";
import type { InvoiceDetail as Data } from "../api";
import { Avatar, Hero, Loading, Notice, Page, Pill, Row, Section } from "../components/ui";
import {
  APPROVER_ROLE, INVOICE_STATUS, METHOD, PROVINCE, dateTime, instant, longDate, money, shortDate, statusOf, type Tone,
} from "../format";
import { useApi, useSession } from "../session";

// One page tells the whole story of an invoice: what it is, what we checked, who approved it, how it was
// paid. This is also the audit-trail view the brief asks for (payment -> invoice -> approvals -> GL codes).

const SEVERITY_TONE: Record<string, Tone> = { block: "negative", warn: "warning", info: "info" };

function statusSentence(d: Data, today: string): string {
  const inv = d.invoice;
  const pay = d.payments.at(-1);
  const method = pay ? (METHOD[pay.method] ?? pay.method).toLowerCase() : "";
  switch (inv.status) {
    case "paid":
      if (!pay) return "Paid";
      if (pay.status === "outstanding") return `Cheque sent ${shortDate(pay.paid_date, today)}, not cashed yet`;
      return `Paid ${shortDate(pay.paid_date, today)} by ${method}`;
    case "scheduled":
      return pay ? `Payment scheduled for ${shortDate(pay.scheduled_date, today)} by ${method}` : "Payment scheduled";
    case "rejected": {
      const r = d.approvals.find((a) => a.action === "rejected");
      return r ? `Rejected by ${r.approver_name}${r.comment ? `: “${r.comment}”` : ""}` : "Rejected";
    }
    case "pending_approval": {
      const p = d.approvals.find((a) => a.action === "pending");
      return p ? `Waiting for ${p.approver_name} to approve` : "Waiting for approval";
    }
    case "approved":
      return "Approved, payment not scheduled yet";
    case "on_hold":
      return inv.hold_reason ?? "On hold";
    case "needs_review":
      return "A person needs to check what we read from the document";
    case "extracting":
      return "Reading the document…";
    default:
      return statusOf(INVOICE_STATUS, inv.status).label;
  }
}

type Step = { key: string; title: string; sub: string; dot: "" | "pending" | "positive" | "negative"; note?: string };

function historySteps(d: Data, today: string): Step[] {
  const inv = d.invoice;
  const steps: Step[] = [];
  if (inv.received_date) {
    const how = inv.source === "email" ? " by email" : inv.source === "upload" ? " by upload" : "";
    steps.push({ key: "received", title: `Received${how}`, sub: longDate(inv.received_date), dot: "" });
  }
  for (const a of d.approvals) {
    const role = APPROVER_ROLE[a.approver_role] ?? a.approver_role;
    const delegated = a.on_behalf_of_name ? ` · on behalf of ${a.on_behalf_of_name}` : "";
    if (a.action === "pending") {
      steps.push({ key: a.approval_id, title: `Waiting for ${a.approver_name}`, sub: `${role}${delegated}`, dot: "pending", note: a.routing_note ?? undefined });
    } else {
      steps.push({
        key: a.approval_id,
        title: `${a.action === "approved" ? "Approved" : "Rejected"} by ${a.approver_name}`,
        sub: `${role}${delegated} · ${dateTime(a.acted_at, today)}`,
        dot: a.action === "approved" ? "" : "negative",
        note: a.comment ?? a.routing_note ?? undefined,
      });
    }
  }
  for (const p of d.payments) {
    const method = METHOD[p.method] ?? p.method;
    const who = [p.prepared_by_name && `prepared by ${p.prepared_by_name}`, p.released_by_name && `released by ${p.released_by_name}`]
      .filter(Boolean).join(", ");
    if (p.status === "settled") {
      steps.push({ key: p.payment_id, title: `Paid by ${method.toLowerCase()}`, sub: `${shortDate(p.paid_date, today)} · ${p.payment_id}${who ? ` · ${who}` : ""}`, dot: "positive" });
    } else if (p.status === "outstanding") {
      steps.push({ key: p.payment_id, title: "Cheque sent, not cashed yet", sub: `${shortDate(p.paid_date, today)} · ${p.payment_id}${who ? ` · ${who}` : ""}`, dot: "" });
    } else {
      steps.push({ key: p.payment_id, title: `Payment ${p.status} · ${method.toLowerCase()}`, sub: `For ${shortDate(p.scheduled_date, today)} · ${p.payment_id}${who ? ` · ${who}` : ""}`, dot: "pending", note: p.hold_reason ?? undefined });
    }
  }
  for (const e of d.history) {
    const actor = e.actor_name ?? "System";
    steps.push({ key: `e${e.event_id}`, title: `${e.action.replace(/[._]/g, " ")} · ${actor}`, sub: instant(e.created_at), dot: "", note: e.reason ?? undefined });
  }
  return steps;
}

function taxLabels(province: string | null): [string, string] {
  if (province === "ON") return ["HST", "PST/QST"];
  if (province === "QC") return ["GST", "QST"];
  if (province === "BC") return ["GST", "PST"];
  return ["GST", "PST/QST"];
}

export default function InvoiceDetail() {
  const { invoiceId } = useParams();
  const { today } = useSession();
  const navigate = useNavigate();
  const { data, error } = useApi<Data>(`/invoices/${invoiceId}`);
  if (!data || data.invoice.invoice_id !== invoiceId) return <Loading error={error} />;

  const inv = data.invoice;
  const status = statusOf(INVOICE_STATUS, inv.status);
  const [gstLabel, pstLabel] = taxLabels(inv.ship_to_province);

  return (
    <Page>
      <button className="back-link" onClick={() => navigate(-1)}>← Back</button>

      <Row
        avatar={<Avatar name={inv.vendor_name ?? "Unknown vendor"} />}
        title={inv.vendor_id ? <Link to={`/vendors/${inv.vendor_id}`}>{inv.vendor_name}</Link> : "Vendor not in our list"}
        sub={`Invoice ${inv.vendor_invoice_number ?? "—"} · ${inv.invoice_id}`}
      />

      <div className="section" style={{ marginTop: 28 }}>
        <Hero
          label={inv.is_credit_note ? "Credit note" : "Amount"}
          value={money(inv.total_cents, inv.currency)}
          caption={<><Pill tone={status.tone}>{status.label}</Pill><span>{statusSentence(data, today)}</span></>}
        />
        {inv.currency !== "CAD" && inv.total_cad_cents !== null && (
          <p className="muted" style={{ margin: "6px 0 0" }}>
            ≈ {money(inv.total_cad_cents)} at {inv.fx_rate_to_cad} on {shortDate(inv.invoice_date, today)}
          </p>
        )}
      </div>

      {data.checks.length > 0 && (
        <Section title="What we checked">
          {data.checks.map((c) => (
            <Notice key={c.check_id} tone={SEVERITY_TONE[c.severity]} title={c.message} />
          ))}
        </Section>
      )}

      <Section title="Details">
        <dl className="kv">
          <dt>Invoice date</dt><dd>{longDate(inv.invoice_date)}</dd>
          <dt>Due</dt><dd>{longDate(inv.due_date)}</dd>
          <dt>Department</dt><dd>{inv.department_name ?? "—"}</dd>
          <dt>Requested by</dt><dd>{inv.requester_name ?? "—"}</dd>
          <dt>Delivered to</dt><dd>{inv.ship_to_province ? (PROVINCE[inv.ship_to_province] ?? inv.ship_to_province) : "—"}</dd>
          <dt>Purchase order</dt>
          <dd>{data.po ? `${data.po.po_id} · ${data.po.description}` : "None"}</dd>
          <dt>Contract</dt>
          <dd>{data.contract ? `${data.contract.contract_id} · ${data.contract.description}` : "None"}</dd>
        </dl>
      </Section>

      <Section title="Lines" caption="Each line shows where the cost is charged: ledger account and department.">
        <div className="list">
          {data.lines.map((l) => (
            <Row
              key={l.line_no}
              title={l.description}
              sub={[
                `${Number(l.quantity)} × ${money(l.unit_price_cents, inv.currency)}`,
                l.gl_account && `${l.gl_account} ${l.gl_name ?? ""}`.trim(),
                l.department_name,
              ].filter(Boolean).join(" · ")}
              end={<span className="row-amount">{money(l.amount_cents, inv.currency)}</span>}
            />
          ))}
        </div>
        <div className="totals">
          <div><span>Subtotal</span><span>{money(inv.subtotal_cents, inv.currency)}</span></div>
          {!!inv.gst_hst_cents && <div><span>{gstLabel}</span><span>{money(inv.gst_hst_cents, inv.currency)}</span></div>}
          {!!inv.pst_qst_cents && <div><span>{pstLabel}</span><span>{money(inv.pst_qst_cents, inv.currency)}</span></div>}
          <div className="grand"><span>Total</span><span>{money(inv.total_cents, inv.currency)}</span></div>
        </div>
      </Section>

      <Section title="History">
        <ol className="timeline">
          {historySteps(data, today).map((s) => (
            <li key={s.key}>
              <span className={`tl-dot ${s.dot}`} />
              <div className="tl-title">{s.title}</div>
              <div className="tl-sub">{s.sub}</div>
              {s.note && <div className="tl-note">{s.note}</div>}
            </li>
          ))}
        </ol>
      </Section>
    </Page>
  );
}
