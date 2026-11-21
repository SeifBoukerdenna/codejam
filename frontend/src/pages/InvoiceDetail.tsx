import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, FileSearchOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { send, type Email, type InvoiceDetail as Data, type Permission } from "../api";
import { ReasonModal, useRunner } from "../components/actions";
import InvoiceEditor from "../components/InvoiceEditor";
import CardPanel from "../components/CardPanel";
import { DataTable } from "../components/DataTable";
import { ActionButton, Avatar, Check, Chips, EntityHead, Hero, Loading, Money, Notice, Page, Panel, Pill, Section, Stat, StatusPill,
  Tiles } from "../components/ui";
import VendorForm from "../components/VendorForm";
import {
  APPROVER_ROLE, INVOICE_STATUS, METHOD, PAYMENT_STATUS, PROVINCE, dateTime, instant, longDate, money, shortDate, statusOf,
  type Tone,
} from "../format";
import { useApi, useSession } from "../session";

// One page tells the whole story of an invoice. The right panel holds the ONE next action for whoever is
// looking, plus who approves it and how it gets paid.

const SEVERITY_TONE: Record<string, Tone> = { block: "negative", warn: "warning", info: "info" };
// A passed check (TAX_OK, PO_MATCHED...) is good news.
const checkTone = (c: { severity: string; code: string }): Tone =>
  c.severity === "info" && /_OK$|_MATCHED$/.test(c.code) ? "positive" : SEVERITY_TONE[c.severity];

function statusSentence(d: Data, today: string, me?: string | null): string {
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

type Step = { key: string; title: string; sub: string; dot: "" | "pending" | "positive" | "negative"; note?: string };

const EVENT_WORDS: Record<string, string> = {
  "invoice.create": "Read from the document", "invoice.submit": "Sent for approval", "invoice.edit": "Corrected",
  "invoice.recode": "Ledger account changed", "invoice.acknowledge_warning": "Warning acknowledged",
  "invoice.on_hold": "Put on hold", "invoice.needs_review": "Sent to review", "invoice.reject": "Rejected",
  "invoice.withdraw_from_approval": "Taken back from approval", "payment.prepare": "Payment prepared",
  "payment.hold": "Payment held", "payment.unhold": "Hold lifted", "payment.release": "Payment released",
  "payment.settle": "Payment confirmed", "payment.cancel": "Payment stopped",
  "card.issued": "Single-use card sent", "card.charge_approved": "Card charge approved",
  "card.charge_declined": "Card charge declined",
};

// Audit events as timeline steps (approvals get their role and delegation spelled out).
function eventSteps(d: Data): Step[] {
  const steps: Step[] = [];
  const stepByNo = new Map(d.approvals.map((a) => [a.step_no, a]));
  for (const e of d.history) {
    if (e.action === "invoice.approve" || e.action === "invoice.decline") {
      const a = stepByNo.get(Number((e.after as { step?: number } | null)?.step));
      steps.push({
        key: `e${e.event_id}`, title: `${e.action === "invoice.approve" ? "Approved" : "Declined"} by ${e.actor_name}`,
        sub: [a && (APPROVER_ROLE[a.approver_role] ?? a.approver_role), e.on_behalf_of_name && `for ${e.on_behalf_of_name}`,
          instant(e.created_at)].filter(Boolean).join(" · "),
        dot: e.action === "invoice.approve" ? "" : "negative", note: e.reason ?? undefined,
      });
      continue;
    }
    if (e.action === "invoice.fully_approved" || e.action === "invoice.rejected") continue;
    steps.push({
      key: `e${e.event_id}`, title: `${EVENT_WORDS[e.action] ?? e.action.replace(/[._]/g, " ")}${e.actor_name ? ` · ${e.actor_name}` : ""}`,
      sub: instant(e.created_at),
      dot: e.action.includes("hold") || e.action === "card.charge_declined" ? "negative" : e.action === "payment.settle" ? "positive" : "",
      note: e.reason ?? undefined,
    });
  }
  return steps;
}

function historySteps(d: Data, today: string): Step[] {
  const inv = d.invoice;
  // The audit log IS the history, in the order things happened.
  if (inv.source !== "history") return eventSteps(d);
  const steps: Step[] = [];
  // History invoices (from the dataset) have no audit events: rebuild the story from approvals and payments.
  if (inv.received_date) steps.push({ key: "received", title: "Received", sub: longDate(inv.received_date), dot: "" });
  for (const a of d.approvals) {
    steps.push({ key: a.approval_id, title: `${a.action === "approved" ? "Approved" : "Declined"} by ${a.approver_name}`,
      sub: `${APPROVER_ROLE[a.approver_role] ?? a.approver_role} · ${dateTime(a.acted_at, today)}`,
      dot: a.action === "approved" ? "" : "negative", note: a.comment ?? undefined });
  }
  // Payments made in the app today are told by their audit events below, not rebuilt here.
  const appPayments = new Set(d.history.flatMap((e) => [e.entity_type === "payment" ? e.entity_id : null,
    (e.after as { payment_id?: string } | null)?.payment_id ?? null]));
  for (const p of d.payments.filter((p) => !appPayments.has(p.payment_id))) {
    const method = (METHOD[p.method] ?? p.method).toLowerCase();
    steps.push({ key: p.payment_id,
      title: p.status === "settled" ? `Paid by ${method}` : p.status === "outstanding" ? "Cheque sent, not cashed yet" : `Payment ${p.status}`,
      sub: `${p.paid_date ? shortDate(p.paid_date, today) : `for ${shortDate(p.scheduled_date, today)}`} · ${p.payment_id}`,
      dot: p.status === "settled" ? "positive" : "" });
  }
  return [...steps, ...eventSteps(d)];
}

// What was printed on the document (identity + where to pay). Business details live in "Details" below.
const READ_FIELDS: [string, string][] = [
  ["invoice_number", "Invoice number"], ["invoice_date", "Invoice date"], ["vendor_gst", "GST/HST number"],
  ["bank_institution", "Institution"], ["bank_transit", "Transit"], ["bank_account", "Account"],
];

export default function InvoiceDetail() {
  const { invoiceId } = useParams();
  const { today, userId } = useSession();
  const navigate = useNavigate();
  const run = useRunner();
  const { data, error, reload } = useApi<Data>(`/invoices/${invoiceId}`);
  const { data: email } = useApi<Email>(data?.invoice.email_id ? `/emails/${data.invoice.email_id}` : null);
  const [modal, setModal] = useState<null | "decline" | "reject" | "cancel">(null);
  const [editing, setEditing] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [method, setMethod] = useState<string | null>(null);
  if (!data || data.invoice.invoice_id !== invoiceId) return <Loading error={error} />;

  const inv = data.invoice;
  const a = data.actions;
  const status = statusOf(INVOICE_STATUS, inv.status);
  const amount = money(inv.total_cents, inv.currency);
  const pay = data.payments.filter((p) => p.status !== "cancelled").at(-1);
  const x = data.extraction;
  const post = (path: string, body?: unknown) => () => send("POST", path, body ?? {});
  const payBy = method ?? inv.vendor_pay_method ?? "EFT";

  // The single next step for this person, in the order the work flows. If it exists but they may not do it,
  // it shows disabled with the server's reason: that's how separation of duties is visible in the demo.
  const candidates: { perm: Permission; label: string; act: () => Promise<unknown>; done: string; link?: { to: string; label: string } }[] = [
    { perm: a.approve, label: `Approve ${amount}`, act: post(`/invoices/${inv.invoice_id}/approve`), done: "Approved",
      link: { to: "/approvals", label: "Next approval" } },
    { perm: a.submit, label: "Submit for approval", act: post(`/invoices/${inv.invoice_id}/submit`), done: "Sent for approval" },
    { perm: a.prepare_payment, label: `Pay ${amount}`, act: post(`/invoices/${inv.invoice_id}/payment`, { method: payBy }), done: "Payment prepared",
      link: { to: "/payments?tab=prepared", label: "See payments to release" } },
    { perm: a.release, label: `Release ${money(pay?.amount_cents, pay?.currency)}`, act: post(`/payments/${a.payment_id}/release`), done: "Payment released" },
    { perm: a.recheck_payment, label: "Re-check the hold", act: post(`/payments/${a.payment_id}/recheck`), done: "Hold lifted" },
    { perm: a.settle, label: "Record bank confirmation", act: post(`/payments/${a.payment_id}/settle`), done: "Marked as paid" },
    { perm: a.recheck, label: "Run the checks again", act: post(`/invoices/${inv.invoice_id}/recheck`), done: "Checks re-run" },
  ];
  const primary = candidates.filter((c) => c.perm).find((c) => c.perm!.allowed) ?? candidates.find((c) => c.perm);
  const problems = data.checks.filter((c) => c.severity !== "info");
  const passed = data.checks.filter((c) => c.severity === "info");
  const firstPending = data.approvals.find((s) => s.action === "pending")?.step_no;

  const rail = (
    <>
      <Panel>
        <Pill tone={status.tone}>{status.label}</Pill>
        <div className="status-sentence">{statusSentence(data, today, userId)}</div>
        {data.review_reasons.length > 0 && (
          <div className="checks mt-2">
            {data.review_reasons.map((r) => <Check key={r} tone="warning">{r}</Check>)}
          </div>
        )}
        {a.prepare_payment?.allowed && (
          <div className="mt-4">
            <div className="small muted mb-2">Pay by</div>
            <Chips label="Pay by" value={payBy} onChange={setMethod} options={[
              { value: "EFT", label: "Bank transfer" }, { value: "CARD", label: "Virtual card" }, { value: "CHEQUE", label: "Cheque" },
            ]} />
          </div>
        )}
        <div className="panel-actions">
          {primary && (
            <ActionButton perm={primary.perm} onRun={() => run(primary.act, primary.done, reload, primary.link)}>{primary.label}</ActionButton>
          )}
          {a.decline?.allowed && <Button className="soft" size="large" shape="round" onClick={() => setModal("decline")}>Decline</Button>}
          {a.edit?.allowed && <Button className="soft" size="large" shape="round" onClick={() => setEditing(true)}>Correct fields</Button>}
          {a.reject?.allowed && !a.decline && <Button className="danger-soft" size="large" shape="round" onClick={() => setModal("reject")}>Reject invoice</Button>}
          {a.cancel_payment?.allowed && <Button className="danger-soft" size="large" shape="round" onClick={() => setModal("cancel")}>Stop payment</Button>}
        </div>
        {!primary && !a.edit?.allowed && !a.cancel_payment?.allowed && <div className="reason">Nothing for you to do here.</div>}
      </Panel>

      {data.approvals.length > 0 && (
        <Panel title="Approvals">
          <div className="steps">
            {data.approvals.map((s) => (
              <div className="step" key={s.approval_id}>
                <div className={`step-mark ${s.action === "approved" ? "done" : s.action === "rejected" ? "declined" : s.step_no === firstPending ? "now" : ""}`}>
                  {s.action === "approved" ? <CheckOutlined /> : s.action === "rejected" ? <CloseOutlined /> : s.step_no}
                </div>
                <div className="min-0">
                  <div className="step-name">{s.approver_name}</div>
                  <div className="step-sub">
                    {APPROVER_ROLE[s.approver_role] ?? s.approver_role}{s.rule_ids ? ` · ${s.rule_ids}` : ""}
                    {s.on_behalf_of_name ? ` · for ${s.on_behalf_of_name}` : ""}
                  </div>
                  {s.routing_note && <div className="step-sub mt-1">{s.routing_note}</div>}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {pay && (
        <Panel title="Payment">
          <Stat label="Status" value={<StatusPill kind="payment" status={pay.status} />} />
          <Stat label="Amount" value={<Money cents={pay.amount_cents} currency={pay.currency} />} />
          {!!pay.credit_applied_cents && <Stat label="Credit deducted" value={<Money cents={pay.credit_applied_cents} />} />}
          <div className="panel-stat"><span>Method</span><span>{METHOD[pay.method] ?? pay.method}</span></div>
          <div className="panel-stat"><span>{pay.paid_date ? "Paid" : "Date"}</span><span>{shortDate(pay.paid_date ?? pay.scheduled_date, today)}</span></div>
          {pay.reference && <div className="panel-stat"><span>Reference</span><span>{pay.reference}</span></div>}
          {pay.prepared_by_name && <div className="panel-stat"><span>Prepared by</span><span>{pay.prepared_by_name}</span></div>}
          {pay.released_by_name && <div className="panel-stat"><span>Released by</span><span>{pay.released_by_name}</span></div>}
        </Panel>
      )}

      {data.card && <CardPanel key={data.card.card_id} card={data.card} attempts={data.card_attempts}
        permission={a.charge_card} onChanged={reload} />}
    </>
  );

  const head = (
    <>
      <button className="link-button mb-5" onClick={() => navigate(-1)}><ArrowLeftOutlined aria-hidden /> Back</button>
      <EntityHead avatar={<Avatar name={inv.vendor_name ?? x?.fields.vendor_name ?? "?"} size="lg" />}
        title={inv.vendor_id ? <Link to={`/vendors/${inv.vendor_id}`}>{inv.vendor_name}</Link> : x?.fields.vendor_name ?? "Unknown vendor"}
        sub={`${inv.is_credit_note ? "Credit note" : "Invoice"} ${inv.vendor_invoice_number ?? "—"} · ${inv.invoice_id}`} />

      <Hero label={inv.is_credit_note ? "Credit" : "Amount"} cents={inv.total_cents ?? undefined} currency={inv.currency}
        meta={inv.currency !== "CAD" && inv.total_cad_cents !== null
          ? <span>≈ <Money cents={inv.total_cad_cents} /> at {inv.fx_rate_to_cad} on {shortDate(inv.invoice_date, today)}</span>
          : <span>Due {longDate(inv.due_date)}</span>} />
    </>
  );

  return (
    <Page rail={rail} railFirst head={head}>

      {pay?.status === "held" && <Notice tone="negative" title="Payment on hold">{pay.hold_reason}</Notice>}
      {!inv.vendor_id && a.edit?.allowed && (
        <Notice tone="info" title="This vendor isn't in our list yet">
          <Button className="soft mt-2" shape="round" onClick={() => setOnboarding(true)}>Add this vendor</Button>
        </Notice>
      )}
      {data.audit_notes.map((n) => <Notice key={n} tone="negative" title="Audit finding">{n}</Notice>)}

      {data.checks.length > 0 && (
        <Section title="Checks" extra={passed.length ? <span>{passed.length} passed</span> : undefined}>
          <div className="checks">
            {[...problems, ...passed].map((c) => (
              <Check key={c.check_id} tone={checkTone(c)} meta={c.severity === "warn" && (c.acknowledged_by
                ? `Checked by ${c.acknowledged_by_name}`
                : a.edit?.allowed && (
                  <Button className="soft mt-1" size="small" shape="round" onClick={() => run(
                    () => send("POST", `/invoices/${inv.invoice_id}/checks/${c.check_id}/acknowledge`), "Marked as checked", reload)}>
                    Mark as checked</Button>))}>
                {c.message}
              </Check>
            ))}
          </div>
        </Section>
      )}

      {x && (
        <Section title="What we read" extra={
          <a href={`/api/documents/${x.document_id}/file`} target="_blank" rel="noreferrer"><FileSearchOutlined /> Original</a>}>
          <p className="muted small m-0 mb-3">
            {x.engine === "text_layer" ? "From the PDF's text" : "Scanned image, 3 OCR passes compared"}
            {x.fields.language === "fr" ? " · French" : ""}
            {x.doubtful.length ? ` · ${x.doubtful.length} to confirm` : " · high confidence"}
            {inv.reviewed_by_name ? ` · confirmed by ${inv.reviewed_by_name}` : ""}
          </p>
          <Tiles items={READ_FIELDS.map(([key, label]) => {
            const conf = x.field_confidence[key];
            const raw = x.fields[key];
            const doubtful = conf && conf.score !== null && conf.score < 0.8;
            return { label, value: key === "total_cents" ? money(raw as number, inv.currency) : (raw as string | null) ?? "—",
              note: doubtful ? conf.note : undefined };
          })} />
        </Section>
      )}

      <Section title="Details">
        <Tiles items={[
          { label: "Department", value: inv.department_name ?? "Not set" },
          { label: "Requested by", value: inv.requester_name ?? "Not set" },
          { label: "Delivered to", value: inv.ship_to_province ? PROVINCE[inv.ship_to_province] ?? inv.ship_to_province : "—" },
          { label: "Purchase order", value: data.po ? data.po.po_id : "None" },
          { label: "Contract", value: data.contract ? `${data.contract.contract_id} · ${data.contract.description}` : "None" },
          { label: "Came in", value: email ? `Email · ${email.from_address}` : inv.source === "upload" ? "Upload" : inv.source === "history" ? "History" : "—" },
        ]} />
      </Section>

      <Section title="Lines">
        <DataTable label="Invoice lines" rows={data.lines} rowKey={(l) => String(l.line_no)} columns={[
          { key: "desc", title: "Description", render: (l) => (
            <div className="min-0">
              <div className="cell-main">{l.description}</div>
              <div className="cell-sub">{l.gl_account ? `${l.gl_account} ${l.gl_name ?? ""}` : "No ledger account yet"}</div>
              {l.coding_reason && <div className="cell-sub wrap">{l.coding_reason}</div>}
            </div>) },
          { key: "qty", title: "Qty", align: "right", optional: true, width: "num", render: (l) => Number(l.quantity) },
          { key: "unit", title: "Unit price", align: "right", optional: "wide", width: "amount", render: (l) => <Money cents={l.unit_price_cents} currency={inv.currency} /> },
          { key: "amount", title: "Amount", align: "right", width: "amount", render: (l) => <Money cents={l.amount_cents} currency={inv.currency} /> },
        ]} />
        <div className="totals">
          <div><span>Subtotal</span><Money cents={inv.subtotal_cents} currency={inv.currency} /></div>
          {!!inv.gst_hst_cents && <div><span>{inv.ship_to_province === "ON" ? "HST" : "GST"}</span><Money cents={inv.gst_hst_cents} currency={inv.currency} /></div>}
          {!!inv.pst_qst_cents && <div><span>{inv.ship_to_province === "QC" ? "QST" : "PST"}</span><Money cents={inv.pst_qst_cents} currency={inv.currency} /></div>}
          <div className="grand"><span>Total</span><Money cents={inv.total_cents} currency={inv.currency} /></div>
        </div>
      </Section>

      <Section title="Activity">
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
        initial={{ legal_name: x?.fields.vendor_name, gst_hst_number: x?.fields.vendor_gst, bank_institution: x?.fields.bank_institution,
          bank_transit: x?.fields.bank_transit, bank_account: x?.fields.bank_account, ap_contact_email: email?.from_address }} />
    </Page>
  );
}
