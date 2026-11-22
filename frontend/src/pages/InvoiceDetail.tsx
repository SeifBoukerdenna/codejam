import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { send, type Email, type FieldSource, type InvoiceDetail as Data, type Permission } from "../api";
import { ReasonModal, useRunner } from "../components/actions";
import CardPanel from "../components/CardPanel";
import { PALETTE_KEYS, rememberVisit } from "../components/CommandPalette";
import { DataTable, readQueue } from "../components/DataTable";
import DocumentViewer from "../components/DocumentViewer";
import InvoiceEditor from "../components/InvoiceEditor";
import { lifeEvents, pipelineSteps, statusSentence } from "../components/invoiceStory";
import PipelineStrip from "../components/PipelineStrip";
import { ShortcutsHelp, useShortcuts } from "../components/Shortcuts";
import { ActionButton, Avatar, Check, Chips, EntityHead, Hero, Kbd, Loading, Money, Notice, Panel, Pill, Section, Stat,
  StatusPill, Tiles } from "../components/ui";
import VendorForm from "../components/VendorForm";
import { APPROVER_ROLE, METHOD, PROVINCE, money, plural, shortDate, type Tone } from "../format";
import { useApi, useSession } from "../session";

// The hero screen. Left: the real document, with a box around every value we read. Right: what we read, what the
// checks found, and the ONE next action for whoever is looking. On top: where the invoice is in its life.

const SEVERITY_TONE: Record<string, Tone> = { block: "negative", warn: "warning", info: "info" };
// A passed check (TAX_OK, PO_MATCHED...) is good news.
const checkTone = (c: { severity: string; code: string }): Tone =>
  c.severity === "info" && /_OK$|_MATCHED$/.test(c.code) ? "positive" : SEVERITY_TONE[c.severity];

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor", invoice_number: "Invoice number", invoice_date: "Invoice date", due_date: "Due date",
  vendor_gst: "GST/HST number", vendor_qst: "QST number", bank_institution: "Institution", bank_transit: "Transit",
  bank_account: "Account", subtotal_cents: "Subtotal", total_cents: "Total",
};
const TAX_LABELS: Record<string, string> = { HST13: "HST 13%", GST5: "GST 5%", QST9975: "QST 9.975%", PST7_BC: "PST 7% (BC)" };
const labelOf = (field: string) => FIELD_LABELS[field] ?? (field.startsWith("line:") ? `Line ${field.slice(5)}`
  : field.startsWith("tax:") ? TAX_LABELS[field.slice(4)] ?? field.slice(4) : field);
// Which PATCH key corrects each field (the API's edit endpoint). Fields not listed can't be picked from OCR readings.
const PATCH_KEY: Record<string, string> = {
  invoice_number: "vendor_invoice_number", invoice_date: "invoice_date", due_date: "due_date", vendor_gst: "vendor_gst",
  bank_institution: "bank_institution", bank_transit: "bank_transit", bank_account: "bank_account",
};

export default function InvoiceDetail() {
  const { invoiceId } = useParams();
  const { data, error, reload } = useApi<Data>(`/invoices/${invoiceId}`);
  const { data: email } = useApi<Email>(data?.invoice.email_id ? `/emails/${data.invoice.email_id}` : null);
  if (!data || data.invoice.invoice_id !== invoiceId) return <Loading error={error} />;
  return <InvoiceView key={invoiceId} data={data} email={email} reload={reload} />;
}

function InvoiceView({ data, email, reload }: { data: Data; email?: Email; reload: () => void }) {
  const { today, userId } = useSession();
  const navigate = useNavigate();
  const run = useRunner();
  const { message } = App.useApp();
  const [modal, setModal] = useState<null | "decline" | "reject" | "cancel">(null);
  const [editing, setEditing] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [method, setMethod] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);

  const inv = data.invoice;
  const a = data.actions;
  const amount = money(inv.total_cents, inv.currency);
  const pay = data.payments.filter((p) => p.status !== "cancelled").at(-1);
  const x = data.extraction;
  const post = (path: string, body?: unknown) => () => send("POST", path, body ?? {});
  const payBy = method ?? inv.vendor_pay_method ?? "EFT";
  const sources = new Map((x?.field_sources ?? []).map((s) => [s.field, s]));
  useEffect(() => rememberVisit({ key: inv.invoice_id, kind: "invoice", to: `/invoices/${inv.invoice_id}`,
    title: inv.vendor_name ?? x?.fields.vendor_name ?? "Unknown vendor", sub: `Invoice ${inv.vendor_invoice_number ?? "—"} · ${inv.invoice_id} · ${amount}` }),
  [inv.invoice_id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const blocks = data.checks.filter((c) => c.severity === "block");
  const warns = data.checks.filter((c) => c.severity === "warn");
  const passed = data.checks.filter((c) => c.severity === "info");
  const firstPending = data.approvals.find((s) => s.action === "pending")?.step_no;

  // [ and ]: step through the list this invoice was opened from.
  const queue = readQueue();
  const here = queue?.paths.indexOf(`/invoices/${inv.invoice_id}`) ?? -1;
  const prev = here > 0 ? queue!.paths[here - 1] : null;
  const next = here >= 0 && here < (queue?.paths.length ?? 0) - 1 ? queue!.paths[here + 1] : null;

  // A refused shortcut says why (the server's reason), the same sentence the disabled button shows.
  const tryAction = (perm: Permission | undefined, what: string, act: () => void) => {
    if (!perm) message.info(`Nothing to ${what} on this invoice right now.`);
    else if (perm.allowed) act();
    else message.warning(perm.reason);
  };
  useShortcuts({
    a: () => tryAction(a.approve, "approve", () => run(candidates[0].act, "Approved", reload, candidates[0].link)),
    d: () => tryAction(a.decline, "decline", () => setModal("decline")),
    p: () => (a.release && !a.prepare_payment ? tryAction(a.release, "pay", () => run(candidates[3].act, "Payment released", reload))
      : tryAction(a.prepare_payment, "pay", () => run(candidates[2].act, "Payment prepared", reload, candidates[2].link))),
    e: () => tryAction(a.edit, "correct", () => setEditing(true)),
    "[": () => prev && navigate(prev),
    "]": () => next && navigate(next),
    "?": () => setHelp(true),
  });

  const fieldRows = buildFieldRows(data, sources);
  const steps = pipelineSteps(data, email, today);
  const story = lifeEvents(data, email, today);

  const nextPanel = (
    <Panel>
      <StatusPill kind="invoice" status={inv.status} />
      <div className="status-sentence">{statusSentence(data, today, userId)}</div>
      {data.review_reasons.length > 0 && (
        <div className="checks mt-2">{data.review_reasons.map((r) => <Check key={r} tone="warning">{r}</Check>)}</div>
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
        {primary && <ActionButton perm={primary.perm} onRun={() => run(primary.act, primary.done, reload, primary.link)}>{primary.label}</ActionButton>}
        {a.decline?.allowed && <Button className="soft" size="large" shape="round" onClick={() => setModal("decline")}>Decline</Button>}
        {a.edit?.allowed && <Button className="soft" size="large" shape="round" onClick={() => setEditing(true)}>Correct fields</Button>}
        {a.reject?.allowed && !a.decline && <Button className="danger-soft" size="large" shape="round" onClick={() => setModal("reject")}>Reject invoice</Button>}
        {a.cancel_payment?.allowed && <Button className="danger-soft" size="large" shape="round" onClick={() => setModal("cancel")}>Stop payment</Button>}
      </div>
      {!primary && !a.edit?.allowed && !a.cancel_payment?.allowed && <div className="reason">Nothing for you to do here.</div>}
      <button className="link-button mt-3 hide-touch" onClick={() => setHelp(true)}>Keyboard shortcuts <Kbd>?</Kbd></button>
    </Panel>
  );

  return (
    <div className="invoice-page">
      <div className="spread">
        <button className="link-button" onClick={() => navigate(-1)}><ArrowLeftOutlined aria-hidden /> Back</button>
        {queue && here >= 0 && (
          <div className="queue-nav" aria-label="Step through the list">
            <span className="small muted">{here + 1} of {queue.paths.length} · {queue.label}</span>
            <Tooltip title={<span>Previous <Kbd>[</Kbd></span>}>
              <button className="icon-button" aria-label="Previous invoice" disabled={!prev} onClick={() => prev && navigate(prev)}><LeftOutlined /></button>
            </Tooltip>
            <Tooltip title={<span>Next <Kbd>]</Kbd></span>}>
              <button className="icon-button" aria-label="Next invoice" disabled={!next} onClick={() => next && navigate(next)}><RightOutlined /></button>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="invoice-head">
        <EntityHead avatar={<Avatar name={inv.vendor_name ?? x?.fields.vendor_name ?? "?"} size="lg" />}
          title={inv.vendor_id ? <Link to={`/vendors/${inv.vendor_id}`}>{inv.vendor_name}</Link> : x?.fields.vendor_name ?? "Unknown vendor"}
          sub={`${inv.is_credit_note ? "Credit note" : "Invoice"} ${inv.vendor_invoice_number ?? "—"} · ${inv.invoice_id}`} />
        <Hero label={inv.is_credit_note ? "Credit" : "Amount"} cents={inv.total_cents ?? undefined} currency={inv.currency}
          meta={inv.currency !== "CAD" && inv.total_cad_cents !== null
            ? <span>≈ <Money cents={inv.total_cad_cents} /> at {inv.fx_rate_to_cad} on {shortDate(inv.invoice_date, today)}</span>
            : <span>Due {shortDate(inv.due_date, today)}</span>} />
      </div>
      <PipelineStrip steps={steps} />

      {pay?.status === "held" && <Notice tone="negative" title="Payment on hold">{pay.hold_reason}</Notice>}
      {!inv.vendor_id && a.edit?.allowed && (
        <Notice tone="info" title="This vendor isn't in our list yet">
          <Button className="soft mt-2" shape="round" onClick={() => setOnboarding(true)}>Add this vendor</Button>
        </Notice>
      )}
      {data.audit_notes.map((n) => <Notice key={n} tone="negative" title="Audit finding">{n}</Notice>)}

      <div className={`invoice-split ${x ? "" : "no-doc"}`}>
        {x && (
          <div className="doc-col">
            <DocumentViewer documentId={x.document_id} filename={x.filename} sources={x.field_sources}
              active={active} onActive={setActive} labelOf={labelOf} />
          </div>
        )}

        <div className="next-col">
          {nextPanel}
          {data.card && <CardPanel key={data.card.card_id} card={data.card} attempts={data.card_attempts}
            permission={a.charge_card} onChanged={reload} />}
          {data.approvals.length > 0 && (
            <Panel title="Approvals">
              <div className="steps">
                {data.approvals.map((s) => (
                  <div className="step" key={s.approval_id}>
                    <div className={`step-mark ${s.action === "approved" ? "done" : s.action === "rejected" ? "declined" : s.step_no === firstPending ? "now" : ""}`} aria-hidden>
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
              <Stat label="Method" value={METHOD[pay.method] ?? pay.method} />
              <Stat label={pay.paid_date ? "Paid" : "Date"} value={shortDate(pay.paid_date ?? pay.scheduled_date, today)} />
              {pay.reference && <Stat label="Reference" value={pay.reference} />}
              {pay.prepared_by_name && <Stat label="Prepared by" value={pay.prepared_by_name} />}
              {pay.released_by_name && <Stat label="Released by" value={pay.released_by_name} />}
            </Panel>
          )}
        </div>

        <div className="rest-col">
          {data.checks.length > 0 && (
            <section className="verdict" aria-label="Checks">
              <div className="spread">
                <h2 className="section-title">Checks</h2>
                <div className="cluster">
                  {blocks.length > 0 && <Pill tone="negative">{blocks.length} {plural(blocks.length, "blocks it", "block it")}</Pill>}
                  {warns.length > 0 && <Pill tone="warning">{warns.length} to look at</Pill>}
                  <Pill tone="positive">{passed.length} passed</Pill>
                </div>
              </div>
              <div className="checks mt-2">
                {[...blocks, ...warns, ...passed].map((c) => (
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
            </section>
          )}

          {x && (
            <Section title="What we read" extra={<span>{x.engine === "text_layer" ? "From the PDF's text" : "Scan · 3 OCR passes"}</span>}>
              <div className="fields" onMouseLeave={() => setActive(null)}>
                {fieldRows.map((f) => (
                  <div key={f.field} id={`field-${f.field}`} tabIndex={f.source ? 0 : -1}
                    className={`field-row ${active === f.field ? "active" : ""} ${f.source ? "located" : ""}`}
                    onMouseEnter={() => f.source && setActive(f.field)} onFocus={() => f.source && setActive(f.field)}>
                    <div className="field-label">{labelOf(f.field)}</div>
                    <div className="field-value">
                      {f.value}
                      {f.source?.source === "ocr" && <span className="tag" title="Read by OCR from a scan">OCR</span>}
                    </div>
                    {f.note && <div className={`field-note ${f.settled ? "settled" : ""}`}>{f.note}</div>}
                    {f.readings && (
                      <div className="field-readings">
                        <span className="small muted">The OCR passes read:</span>
                        {f.readings.map((r) => (
                          PATCH_KEY[f.field] && a.edit?.allowed && r !== f.raw
                            ? <button key={r} className="chip" onClick={() => run(() => send("PATCH", `/invoices/${inv.invoice_id}`,
                                { [PATCH_KEY[f.field]]: r, reason: `Picked the OCR reading “${r}” for ${labelOf(f.field).toLowerCase()}` }),
                                `Using “${r}”. Checks re-run.`, reload)}>Use “{r}”</button>
                            : <span key={r} className={`chip ${r === f.raw ? "on" : ""}`}>“{r}”{r === f.raw ? " · used" : ""}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
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
            <DataTable label="Invoice lines" rows={data.lines} rowKey={(l) => String(l.line_no)}
              onRowHover={(l) => setActive(l ? `line:${l.line_no}` : null)} columns={[
                { key: "desc", title: "Description", render: (l) => (
                  <div className={`min-0 ${active === `line:${l.line_no}` ? "line-active" : ""}`}>
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

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Life of this invoice</h2>
              <button className="link-button" aria-expanded={storyOpen} aria-controls="life-of-invoice" onClick={() => setStoryOpen((o) => !o)}>
                {storyOpen ? "Show less" : `Show all ${story.length} steps`}
              </button>
            </div>
            <ol className="timeline" id="life-of-invoice">
              {(storyOpen ? story : [story[0], ...story.slice(-2)].filter((s, i, all) => s && all.indexOf(s) === i)).map((s) => (
                <li key={s.key}>
                  <span className={`tl-dot ${s.tone ?? ""}`} aria-hidden />
                  <div className="tl-title">{s.title}</div>
                  <div className="tl-sub">{s.sub}</div>
                  {s.note && <div className="tl-note">{s.note}</div>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      <ShortcutsHelp open={help} onClose={() => setHelp(false)} items={[
        ["A", "Approve"], ["D", "Decline"], ["P", "Pay (or release)"], ["E", "Correct fields"],
        ["[", "Previous invoice in the list"], ["]", "Next invoice in the list"], ["?", "This list"], [PALETTE_KEYS, "Search, or switch user"],
      ]} />
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
    </div>
  );
}

type FieldRow = { field: string; value: ReactNode; raw?: string; source?: FieldSource; note?: string; settled?: boolean; readings?: string[] };

/** "What we read": every field printed on the document, its current value, where it was found, and doubts. */
function buildFieldRows(d: Data, sources: Map<string, FieldSource>): FieldRow[] {
  const x = d.extraction!;
  if (!x) return [];
  const inv = d.invoice;
  const f = x.fields as Record<string, unknown>;
  // Fields the invoice record owns show their current value (a person may have corrected them since).
  const current: Record<string, unknown> = {
    invoice_number: inv.vendor_invoice_number, invoice_date: inv.invoice_date, due_date: inv.due_date,
  };
  // Once a person has set a field, the machine's "please confirm" is answered: say who set it instead.
  const correctedBy = new Map<string, string>();
  for (const e of d.history) {
    if (e.action !== "invoice.edit") continue;
    for (const key of Object.keys(e.after ?? {})) correctedBy.set(key, e.actor_name ?? "a person");
  }
  const rows: FieldRow[] = [];
  const scalar = (field: string) => {
    const raw = (field in current ? current[field] : f[field]) as string | null | undefined;
    if (!raw && !sources.has(field)) return;
    const conf = x.field_confidence[field];
    const src = sources.get(field);
    const readings = src?.ocr_readings ? [...new Set(src.ocr_readings.filter((r): r is string => !!r))] : [];
    const by = correctedBy.get(PATCH_KEY[field] ?? field);
    rows.push({ field, value: raw ?? "—", raw: raw ?? undefined, source: src,
      settled: !!by, note: by ? `Set by ${by}` : conf && conf.score !== null && conf.score < 0.8 ? conf.note : undefined,
      readings: readings.length > 1 ? readings : undefined });
  };
  ["vendor_name", "invoice_number", "invoice_date", "due_date", "vendor_gst", "vendor_qst",
    "bank_institution", "bank_transit", "bank_account"].forEach(scalar);
  if (inv.subtotal_cents !== null) rows.push({ field: "subtotal_cents", value: <Money cents={inv.subtotal_cents} currency={inv.currency} />, source: sources.get("subtotal_cents") });
  for (const t of (f.taxes as { label: string; rate_pct: string; amount_cents: number; code: string | null }[] | undefined) ?? []) {
    const key = `tax:${t.code ?? t.label}`;
    rows.push({ field: key, value: <Money cents={t.amount_cents} currency={inv.currency} />, source: sources.get(key) });
  }
  if (inv.total_cents !== null) rows.push({ field: "total_cents", value: <Money cents={inv.total_cents} currency={inv.currency} />, source: sources.get("total_cents") });
  return rows;
}
