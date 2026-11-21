import { FileSearchOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { send, type Email, type InvoiceDetail as Data, type Permission } from "../api";
import { ReasonModal, useRunner } from "../components/actions";
import InvoiceEditor from "../components/InvoiceEditor";
import { Avatar, Hero, Loading, Notice, Page, Pill, Row, Section } from "../components/ui";
import VendorForm from "../components/VendorForm";
import {
  APPROVER_ROLE, INVOICE_STATUS, METHOD, PROVINCE, dateTime, instant, longDate, money, shortDate, statusOf, type Tone,
} from "../format";
import { useApi, useSession } from "../session";

// One page tells the whole story of an invoice: what we read, what we checked, who approved it, how it was
// paid, and every change in the audit log. It also carries the ONE next action for whoever is looking.

const SEVERITY_TONE: Record<string, Tone> = { block: "negative", warn: "warning", info: "info" };
// A passed check (TAX_OK, PO_MATCHED...) is good news, so it's green, not informational blue.
const checkTone = (c: { severity: string; code: string }): Tone =>
  c.severity === "info" && /_OK$|_MATCHED$/.test(c.code) ? "positive" : SEVERITY_TONE[c.severity];

function statusSentence(d: Data, today: string): string {
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
      if (pay.status === "prepared") return "Payment ready, waiting for a finance manager to release it";
      if (pay.status === "released") return `Sent by ${method}, waiting for the bank to confirm`;
      return `Payment scheduled for ${shortDate(pay.scheduled_date, today)} by ${method}`;
    case "rejected": {
      const r = d.approvals.find((a) => a.action === "rejected");
      return r ? `Declined by ${r.approver_name}${r.comment ? `: “${r.comment}”` : ""}` : inv.hold_reason ?? "Rejected";
    }
    case "pending_approval": {
      const p = d.approvals.find((a) => a.action === "pending");
      return p ? `Waiting for ${p.approver_name} to approve` : "Waiting for approval";
    }
    case "approved":
      return inv.is_credit_note ? "Approved. Will be deducted from the next payment" : "Approved, ready to pay";
    case "on_hold":
      return "On hold until the problems below are fixed";
    case "needs_review":
      return "A person needs to look at it before it goes for approval";
    default:
      return statusOf(INVOICE_STATUS, inv.status).label;
  }
}

type Step = { key: string; title: string; sub: string; dot: "" | "pending" | "positive" | "negative"; note?: string };

const EVENT_WORDS: Record<string, string> = {
  "invoice.create": "Read from the document", "invoice.submit": "Sent for approval", "invoice.edit": "Corrected",
  "invoice.recode": "Ledger account changed", "invoice.acknowledge_warning": "Warning acknowledged",
  "invoice.on_hold": "Put on hold", "invoice.needs_review": "Sent to review", "invoice.reject": "Rejected",
  "invoice.withdraw_from_approval": "Taken back from approval", "payment.prepare": "Payment prepared",
  "payment.hold": "Payment held", "payment.unhold": "Hold lifted", "payment.release": "Payment released",
  "payment.settle": "Bank confirmed the payment", "payment.cancel": "Payment stopped",
};

function historySteps(d: Data, today: string): Step[] {
  const inv = d.invoice;
  const steps: Step[] = [];

  if (inv.source !== "history") {
    // New invoices: the audit log IS the history, in the order things happened. Approval events get their
    // role, rules and routing note from the approval step they belong to.
    const stepByNo = new Map(d.approvals.map((a) => [a.step_no, a]));
    for (const e of d.history) {
      if (e.action === "invoice.approve" || e.action === "invoice.decline") {
        const a = stepByNo.get(Number((e.after as { step?: number } | null)?.step));
        const role = a ? APPROVER_ROLE[a.approver_role] ?? a.approver_role : "";
        steps.push({
          key: `e${e.event_id}`,
          title: `${e.action === "invoice.approve" ? "Approved" : "Declined"} by ${e.actor_name}`,
          sub: [role, a?.rule_ids, e.on_behalf_of_name && `on behalf of ${e.on_behalf_of_name}`, instant(e.created_at)]
            .filter(Boolean).join(" · "),
          dot: e.action === "invoice.approve" ? "" : "negative",
          note: e.reason ?? a?.routing_note ?? undefined,
        });
        continue;
      }
      if (e.action === "invoice.fully_approved" || e.action === "invoice.rejected") continue;
      steps.push({
        key: `e${e.event_id}`,
        title: `${EVENT_WORDS[e.action] ?? e.action.replace(/[._]/g, " ")}${e.actor_name ? ` · ${e.actor_name}` : ""}`,
        sub: instant(e.created_at), dot: e.action.includes("hold") ? "negative" : e.action === "payment.settle" ? "positive" : "",
        note: e.reason ?? undefined,
      });
    }
    // Steps that haven't happened yet come last.
    for (const a of d.approvals.filter((x) => x.action === "pending")) {
      const role = APPROVER_ROLE[a.approver_role] ?? a.approver_role;
      steps.push({ key: a.approval_id, title: `Waiting for ${a.approver_name}`,
        sub: [role, a.rule_ids, a.on_behalf_of_name && `on behalf of ${a.on_behalf_of_name}`].filter(Boolean).join(" · "),
        dot: "pending", note: a.routing_note ?? undefined });
    }
    return steps;
  }

  // History invoices (from the dataset) have no audit events: rebuild the story from approvals and payments.
  if (inv.received_date) steps.push({ key: "received", title: "Received", sub: longDate(inv.received_date), dot: "" });
  for (const a of d.approvals) {
    const role = APPROVER_ROLE[a.approver_role] ?? a.approver_role;
    steps.push({ key: a.approval_id, title: `${a.action === "approved" ? "Approved" : "Declined"} by ${a.approver_name}`,
      sub: `${role} · ${dateTime(a.acted_at, today)}`, dot: a.action === "approved" ? "" : "negative",
      note: a.comment ?? undefined });
  }
  for (const p of d.payments) {
    const method = METHOD[p.method] ?? p.method;
    const who = [p.prepared_by_name && `prepared by ${p.prepared_by_name}`, p.released_by_name && `released by ${p.released_by_name}`]
      .filter(Boolean).join(", ");
    const title = p.status === "settled" ? `Paid by ${method.toLowerCase()}`
      : p.status === "outstanding" ? "Cheque sent, not cashed yet" : `Payment ${p.status} · ${method.toLowerCase()}`;
    const when = p.paid_date ? shortDate(p.paid_date, today) : `For ${shortDate(p.scheduled_date, today)}`;
    steps.push({ key: p.payment_id, title, sub: `${when} · ${p.payment_id}${who ? ` · ${who}` : ""}`,
      dot: p.status === "settled" ? "positive" : p.status === "outstanding" ? "" : "pending" });
  }
  return steps;
}

const CONFIDENCE_FIELDS: [string, string][] = [
  ["vendor_name", "Vendor"], ["invoice_number", "Invoice number"], ["invoice_date", "Invoice date"], ["due_date", "Due"],
  ["vendor_gst", "GST/HST number"], ["bank_institution", "Institution"], ["bank_transit", "Transit"],
  ["bank_account", "Account"], ["total_cents", "Total"], ["lines", "Lines"],
];

function confidenceTone(score: number): Tone {
  return score >= 0.8 ? "positive" : score >= 0.6 ? "warning" : "negative";
}

export default function InvoiceDetail() {
  const { invoiceId } = useParams();
  const { today } = useSession();
  const navigate = useNavigate();
  const run = useRunner();
  const { data, error, reload } = useApi<Data>(`/invoices/${invoiceId}`);
  const { data: email } = useApi<Email>(data?.invoice.email_id ? `/emails/${data.invoice.email_id}` : null);
  const [modal, setModal] = useState<null | "decline" | "reject" | "cancel">(null);
  const [editing, setEditing] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  if (!data || data.invoice.invoice_id !== invoiceId) return <Loading error={error} />;

  const inv = data.invoice;
  const a = data.actions;
  const status = statusOf(INVOICE_STATUS, inv.status);
  const amount = money(inv.total_cents, inv.currency);
  const pay = data.payments.filter((p) => p.status !== "cancelled").at(-1);
  const x = data.extraction;
  const post = (path: string, body?: unknown) => () => send("POST", path, body ?? {});

  // The single next step for this person, in the order the work flows. If it exists but they may not do it,
  // it shows disabled with the server's reason: that's how separation of duties is visible in the demo.
  const candidates: { perm: Permission; label: string; act: () => Promise<unknown>; done: string }[] = [
    { perm: a.approve, label: `Approve ${amount}`, act: post(`/invoices/${inv.invoice_id}/approve`), done: "Approved" },
    { perm: a.submit, label: "Submit for approval", act: post(`/invoices/${inv.invoice_id}/submit`), done: "Sent for approval" },
    { perm: a.prepare_payment, label: `Pay ${amount}`, act: post(`/invoices/${inv.invoice_id}/payment`), done: "Payment prepared" },
    { perm: a.release, label: `Release ${money(pay?.amount_cents, pay?.currency)}`, act: post(`/payments/${a.payment_id}/release`), done: "Payment released" },
    { perm: a.recheck_payment, label: "Re-check the hold", act: post(`/payments/${a.payment_id}/recheck`), done: "Hold lifted" },
    { perm: a.settle, label: "Record bank confirmation", act: post(`/payments/${a.payment_id}/settle`), done: "Marked as paid" },
    { perm: a.recheck, label: "Run the checks again", act: post(`/invoices/${inv.invoice_id}/recheck`), done: "Checks re-run" },
  ];
  const applicable = candidates.filter((c) => c.perm);
  const primary = applicable.find((c) => c.perm!.allowed) ?? applicable[0];
  const secondary = (
    <>
      {a.decline?.allowed && <button className="text-button" onClick={() => setModal("decline")}>Decline</button>}
      {a.reject?.allowed && !a.decline && <button className="text-button" onClick={() => setModal("reject")}>Reject invoice</button>}
      {a.cancel_payment?.allowed && <button className="text-button" onClick={() => setModal("cancel")}>Stop payment</button>}
      {a.edit?.allowed && <button className="text-button" onClick={() => setEditing(true)}>Correct fields</button>}
    </>
  );

  return (
    <Page>
      <button className="back-link" onClick={() => navigate(-1)}>← Back</button>

      <Row
        avatar={<Avatar name={inv.vendor_name ?? x?.fields.vendor_name ?? "?"} />}
        title={inv.vendor_id ? <Link to={`/vendors/${inv.vendor_id}`}>{inv.vendor_name}</Link>
          : `${x?.fields.vendor_name ?? "Unknown vendor"} (not in our vendor list)`}
        sub={`${inv.is_credit_note ? "Credit note" : "Invoice"} ${inv.vendor_invoice_number ?? "—"} · ${inv.invoice_id}`}
      />

      <div className="section" style={{ marginTop: 28 }}>
        <Hero
          label={inv.is_credit_note ? "Credit" : "Amount"}
          value={amount}
          caption={<><Pill tone={status.tone}>{status.label}</Pill><span>{statusSentence(data, today)}</span></>}
        />
        {inv.currency !== "CAD" && inv.total_cad_cents !== null && (
          <p className="muted" style={{ margin: "6px 0 0" }}>
            ≈ {money(inv.total_cad_cents)} at {inv.fx_rate_to_cad} on {shortDate(inv.invoice_date, today)}
          </p>
        )}
      </div>

      <div className="section" style={{ marginTop: 24, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        {primary && (
          <Button type="primary" shape="round" size="large" disabled={!primary.perm!.allowed}
            onClick={() => run(primary.act, primary.done, reload)}>{primary.label}</Button>
        )}
        {secondary}
      </div>
      {primary && !primary.perm!.allowed && <p className="muted small" style={{ marginTop: 8 }}>{primary.perm!.reason}</p>}

      {data.review_reasons.length > 0 && (
        <Notice tone="warning" title="Before this can go for approval">
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{data.review_reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </Notice>
      )}
      {pay?.status === "held" && <Notice tone="negative" title="Payment on hold">{pay.hold_reason}</Notice>}
      {!inv.vendor_id && a.edit?.allowed && (
        <Notice tone="info" title="This vendor isn't in our list yet">
          Add it (it starts as “pending review”), or pick the right vendor under Correct fields.{" "}
          <button className="text-button" onClick={() => setOnboarding(true)}>Add this vendor</button>
        </Notice>
      )}
      {data.audit_notes.map((n) => <Notice key={n} tone="negative" title="Audit finding">{n}</Notice>)}

      {data.checks.length > 0 && (
        <Section title="What we checked">
          {data.checks.map((c) => (
            <Notice key={c.check_id} tone={checkTone(c)} title={c.message}>
              {c.severity === "warn" && (c.acknowledged_by
                ? <span>Acknowledged by {c.acknowledged_by_name}.</span>
                : a.edit?.allowed && (
                  <button className="text-button" onClick={() => run(
                    () => send("POST", `/invoices/${inv.invoice_id}/checks/${c.check_id}/acknowledge`), "Acknowledged", reload)}>
                    I've checked this
                  </button>))}
            </Notice>
          ))}
        </Section>
      )}

      {x && (
        <Section title="What we read"
          extra={<a href={`/api/documents/${x.document_id}/file`} target="_blank" rel="noreferrer"><FileSearchOutlined /> Original</a>}
          caption={<>
            {x.engine === "text_layer" ? "Read from the PDF's own text." : "Scanned image, read with OCR (3 passes compared)."}{" "}
            {x.doubtful.length > 0
              ? <Pill tone="warning">{x.doubtful.length} {x.doubtful.length === 1 ? "field" : "fields"} to check</Pill>
              : <Pill tone={confidenceTone(x.overall)}>{x.overall >= 0.8 ? "High" : x.overall >= 0.6 ? "Medium" : "Low"} confidence</Pill>}
            {x.fields.language === "fr" && <> <Pill>French</Pill></>}
            {inv.reviewed_by_name && <> · confirmed by {inv.reviewed_by_name}</>}
          </>}>
          <dl className="kv">
            {CONFIDENCE_FIELDS.map(([key, label]) => {
              const conf = x.field_confidence[key];
              const raw = x.fields[key];
              const value = key === "total_cents" ? money(raw as number, inv.currency)
                : key === "lines" ? `${(raw as unknown[] | undefined)?.length ?? 0} lines` : (raw as string | null) ?? "—";
              const doubtful = conf && conf.score !== null && conf.score < 0.8;
              return [
                <dt key={`${key}-t`}>{label}</dt>,
                <dd key={`${key}-d`}>
                  {value} {doubtful && <Pill tone={confidenceTone(conf.score!)}>check this</Pill>}
                  {doubtful && <div className="muted small" style={{ fontWeight: 400 }}>{conf.note}</div>}
                </dd>,
              ];
            })}
          </dl>
        </Section>
      )}

      <Section title="Details">
        <dl className="kv">
          <dt>Invoice date</dt><dd>{longDate(inv.invoice_date)}</dd>
          <dt>Due</dt><dd>{longDate(inv.due_date)}</dd>
          <dt>Department</dt><dd>{inv.department_name ?? "Not set"}</dd>
          <dt>Requested by</dt><dd>{inv.requester_name ?? "Not set"}</dd>
          <dt>Delivered to</dt><dd>{inv.ship_to_province ? (PROVINCE[inv.ship_to_province] ?? inv.ship_to_province) : "—"}</dd>
          <dt>Purchase order</dt><dd>{data.po ? `${data.po.po_id} · ${data.po.description}` : "None"}</dd>
          <dt>Contract</dt><dd>{data.contract ? `${data.contract.contract_id} · ${data.contract.description}` : "None"}</dd>
          {email && <><dt>Came in</dt><dd>by email from {email.from_address} ({email.email_id})</dd></>}
        </dl>
      </Section>

      <Section title="Lines" caption="Where each cost is charged (ledger account and department) and why we suggested it.">
        <div className="list">
          {data.lines.map((l) => (
            <Row
              key={l.line_no}
              title={l.description}
              sub={<>
                {`${Number(l.quantity)} × ${money(l.unit_price_cents, inv.currency)}`}
                {l.gl_account ? ` · ${l.gl_account} ${l.gl_name ?? ""}` : " · no account yet"}
                {l.department_name ? ` · ${l.department_name}` : ""}
                {l.coding_reason && <div className="small muted" style={{ whiteSpace: "normal" }}>{l.coding_reason}</div>}
              </>}
              end={<span className="row-amount">{money(l.amount_cents, inv.currency)}</span>}
            />
          ))}
        </div>
        <div className="totals">
          <div><span>Subtotal</span><span>{money(inv.subtotal_cents, inv.currency)}</span></div>
          {!!inv.gst_hst_cents && <div><span>{inv.ship_to_province === "ON" ? "HST" : "GST"}</span><span>{money(inv.gst_hst_cents, inv.currency)}</span></div>}
          {!!inv.pst_qst_cents && <div><span>{inv.ship_to_province === "QC" ? "QST" : "PST"}</span><span>{money(inv.pst_qst_cents, inv.currency)}</span></div>}
          <div className="grand"><span>Total</span><span>{money(inv.total_cents, inv.currency)}</span></div>
        </div>
      </Section>

      <Section title="History" caption="Every step, who did it and why, from the audit log (which can't be edited).">
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

      <ReasonModal open={modal !== null}
        title={modal === "decline" ? "Decline this invoice?" : modal === "reject" ? "Reject this invoice?" : "Stop this payment?"}
        okText={modal === "decline" ? "Decline" : modal === "reject" ? "Reject" : "Stop payment"}
        placeholder={modal === "cancel" ? "e.g. Duplicate of PAY-00386" : "e.g. Billed over the contract fee"}
        onClose={() => setModal(null)}
        onSubmit={(reason) => run(
          modal === "decline" ? post(`/invoices/${inv.invoice_id}/decline`, { comment: reason })
            : modal === "reject" ? post(`/invoices/${inv.invoice_id}/reject`, { reason })
              : post(`/payments/${a.payment_id}/cancel`, { reason }),
          modal === "cancel" ? "Payment stopped" : "Done", reload)} />
      <InvoiceEditor data={data} open={editing} onClose={() => setEditing(false)} onSaved={reload} />
      <VendorForm open={onboarding} fromInvoiceId={inv.invoice_id} onClose={() => setOnboarding(false)}
        onCreated={() => { setOnboarding(false); reload(); }}
        initial={{ legal_name: x?.fields.vendor_name, gst_hst_number: x?.fields.vendor_gst,
          bank_institution: x?.fields.bank_institution, bank_transit: x?.fields.bank_transit,
          bank_account: x?.fields.bank_account, ap_contact_email: email?.from_address }} />
    </Page>
  );
}
