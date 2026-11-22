import { Drawer } from "antd";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, send, type AuditEvent, type ChainCheck, type Findings, type Recovery, type TaxAtRisk } from "../api";
import { useRunner } from "../components/actions";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { ActionButton, Avatar, Check, Chips, Draft, EmptyState, EntityHead, Hero, Loading, Money, Notice, Page, PageTitle,
  Panel, Pill, Progress, Row, Section, Stat, StatusPill } from "../components/ui";
import { instant, longDate, plural, type Tone } from "../format";
import { useApi } from "../session";

// What an auditor (and the CFO) wants to know: money that leaked, how to get it back, and who did what.

const ACTION_WORDS: Record<string, string> = {
  "system.seed": "Loaded the Brim dataset", "email.sorted": "Sorted an email", "email.answered": "Answered an email",
  "document.received": "Received a document", "document.read_failed": "Couldn't read a document",
  "invoice.create": "Read an invoice", "invoice.submit": "Sent for approval",
  "invoice.edit": "Corrected an invoice", "invoice.recode": "Changed a ledger account",
  "invoice.acknowledge_warning": "Acknowledged a warning", "invoice.on_hold": "Put an invoice on hold",
  "invoice.needs_review": "Sent an invoice to review", "invoice.approve": "Approved", "invoice.decline": "Declined",
  "invoice.fully_approved": "Invoice fully approved", "invoice.rejected": "Invoice rejected", "invoice.reject": "Rejected an invoice",
  "invoice.withdraw_from_approval": "Took an invoice back from approval", "payment.prepare": "Prepared a payment",
  "payment.hold": "Held a payment", "payment.unhold": "Lifted a payment hold", "payment.release": "Released a payment",
  "payment.settle": "Payment confirmed", "payment.cancel": "Stopped a payment", "credit_note.applied": "Deducted a credit note",
  "vendor.onboard": "Added a vendor", "vendor.approve": "Approved a vendor", "vendor.hold": "Put a vendor on hold",
  "vendor.release_hold": "Released a vendor hold", "vendor.bank_change_requested": "Recorded a bank change",
  "vendor.bank_change_confirmed": "Verified a bank change", "vendor.bank_change_rejected": "Vendor denied a bank change",
  "recovery.requested": "Asked a vendor for a refund", "recovery.recovered": "Got a double payment back",
  "card.issued": "Sent a single-use card", "card.charge_approved": "Card charge approved",
  "card.charge_declined": "Card charge declined", "bank.asked": "Asked the bank about a debit",
  "bank.fee_booked": "Booked a bank fee", "bank.cheque_cashed": "Matched a cashed cheque",
};

const HOW: Record<Recovery["kind"], string> = {
  paid_twice: "Paid twice", about_to_pay_twice: "Scheduled twice", paid_by_ap_and_card: "Paid by AP and on an employee card",
};
const RECOVERY: Record<Recovery["status"], { label: string; tone: Tone }> = {
  to_recover: { label: "To recover", tone: "warning" },
  requested: { label: "Refund requested", tone: "info" },
  recovered: { label: "Recovered", tone: "positive" },
};
const TAX_PROBLEM: Record<string, string> = {
  WRONG_TAX_FOR_PROVINCE: "Wrong tax for the province", PST_ON_SERVICES: "PST charged on services",
  UNEXPECTED_TAX: "Tax that doesn't apply", GST_NUMBER_MISSING: "No GST/HST number", QST_NUMBER_MISSING: "No QST number",
};

type Tab = "paid_twice" | "tax" | "other" | "log";
type SelfApproval = Findings["self_approvals"][number];
type Split = Findings["split_invoices"][number];

const linkFor = (e: AuditEvent) => e.entity_type === "invoice" ? `/invoices/${e.entity_id}`
  : e.entity_type === "vendor" ? `/vendors/${e.entity_id}` : e.entity_type === "bank_line" ? "/bank?tab=done" : undefined;

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "paid_twice";
  const findings = useApi<Findings>("/findings");
  const recoveries = useApi<Recovery[]>(tab === "paid_twice" ? "/recoveries" : null);
  const log = useApi<AuditEvent[]>(tab === "log" ? "/audit" : null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [chain, setChain] = useState<{ result?: ChainCheck; refused?: string }>({});
  const f = findings.data;
  if (!f) return <Loading error={findings.error} />;

  const scheduledTwice = f.double_payments.filter((d) => d.kind === "about_to_pay_twice");
  const paidTwice = f.double_payments.length - scheduledTwice.length;
  const recovered = f.recovery_totals.recovered;
  const reload = () => { findings.reload(); recoveries.reload(); };

  const recoveryColumns: Column<Recovery>[] = [
    { key: "vendor", title: "Vendor", render: (r) => (
      <CellWho avatar={<Avatar name={r.vendor_name} size="sm" />} main={r.vendor_name} sub={`Invoice ${r.invoice_number} · ${HOW[r.kind]}`} />) },
    { key: "status", title: "Status", width: "status", render: (r) => <Pill tone={RECOVERY[r.status].tone}>{RECOVERY[r.status].label}</Pill> },
    { key: "amount", title: "Paid too much", align: "right", width: "amount", render: (r) => <Money cents={r.overpaid_cad_cents} /> },
  ];
  const taxColumns: Column<TaxAtRisk>[] = [
    { key: "vendor", title: "Invoice", render: (t) => (
      <CellWho avatar={<Avatar name={t.vendor_name} size="sm" />} main={`${t.vendor_name ?? "Unknown vendor"} · Invoice ${t.vendor_invoice_number ?? t.invoice_id}`}
        sub={t.fix} />) },
    { key: "status", title: "Status", optional: true, width: "status", render: (t) => <StatusPill kind="invoice" status={t.status} /> },
    { key: "amount", title: "At risk", align: "right", width: "amount", render: (t) => <Money cents={t.at_risk_cents} currency={t.currency} /> },
  ];
  const selfColumns: Column<SelfApproval>[] = [
    { key: "who", title: "Who", render: (s) => (
      <CellWho avatar={<Avatar name={s.full_name} size="sm" round />} main={`${s.full_name} approved their own request`}
        sub={`${s.invoice_id} · ${s.vendor_name}`} />) },
    { key: "amount", title: "Amount", align: "right", width: "amount", render: (s) => <Money cents={s.total_cad_cents} /> },
  ];
  const splitColumns: Column<Split>[] = [
    { key: "vendor", title: "Vendor", render: (s) => (
      <CellWho avatar={<Avatar name={s.vendor_name} size="sm" />} main={s.vendor_name} sub={s.invoice_ids.join(" · ")} />) },
    { key: "amount", title: "Together", align: "right", width: "amount", render: (s) => <Money cents={s.combined_cad_cents} /> },
  ];
  const logColumns: Column<AuditEvent>[] = [
    { key: "what", title: "What happened", render: (e) => (
      <CellWho avatar={<Avatar name={e.actor_name ?? "System"} size="sm" round dark={!e.actor_name} />}
        main={`${ACTION_WORDS[e.action] ?? e.action.replace(/[._]/g, " ")}${e.entity_type !== "database" ? ` · ${e.entity_id}` : ""}`}
        sub={[e.actor_name ?? "System", e.on_behalf_of_name && `for ${e.on_behalf_of_name}`, e.reason].filter(Boolean).join(" · ")} />) },
    { key: "when", title: "When", optional: "wide", width: "when", render: (e) => <span className="small muted">{instant(e.created_at)}</span> },
    { key: "sig", title: "Event · signature", align: "right", optional: "wide", width: "sig",
      render: (e) => <span className="small muted num" title="This event's signature in the audit chain">#{e.event_id} · {e.hash?.slice(0, 8)}</span> },
  ];

  const rail = {
    paid_twice: (
      <Panel title="Getting it back">
        <Stat label="To recover" value={<Money cents={f.recovery_totals.to_recover} />} />
        <Stat label="Refund requested" value={<Money cents={f.recovery_totals.requested} />} />
        <Stat label="Recovered" value={<Money cents={recovered} />} />
        <Progress done={recovered} of={f.overpaid_cad_cents} tone="positive" label="Share of the double payments recovered" />
      </Panel>
    ),
    tax: (
      <Panel title="By problem">
        {f.tax_by_problem.map((t) => <Stat key={t.code} label={TAX_PROBLEM[t.code] ?? t.code} value={<Money cents={t.cents} />} />)}
        {!f.tax_by_problem.length && <div className="muted">Nothing at risk.</div>}
      </Panel>
    ),
    other: (
      <Panel title="Findings">
        <Stat label="Self-approvals" value={f.self_approvals.length} />
        <Stat label="Split invoices" value={f.split_invoices.length} />
      </Panel>
    ),
    log: (
      <Panel title="Audit log">
        <p className="muted small m-0">
          Append-only, and every event is signed together with the one before it: an edit made even with the
          database's protection switched off is found.
        </p>
        <div className="panel-actions">
          <ActionButton onRun={async () => {
            try { setChain({ result: await api<ChainCheck>("/audit/verify") }); }
            catch (e) { setChain({ refused: (e as Error).message }); }
          }}>Verify integrity</ActionButton>
        </div>
        {chain.refused && <div className="reason">{chain.refused}</div>}
        {chain.result && (
          <div className="checks mt-2">
            <Check tone={chain.result.ok ? "positive" : "negative"}
              meta={chain.result.ok ? `${chain.result.checked.toLocaleString("en-CA")} signatures checked · latest ${chain.result.head}…` : undefined}>
              {chain.result.reason}
            </Check>
          </div>
        )}
      </Panel>
    ),
  }[tab];

  return (
    <Page rail={rail}>
      <PageTitle title="Activity" />
      <div className="mt-5">
        <Chips<Tab> label="Activity view" value={tab} onChange={(v) => setParams({ tab: v })} options={[
          { value: "paid_twice", label: "Paid twice" },
          { value: "tax", label: "Tax at risk" },
          { value: "other", label: "Other findings" },
          { value: "log", label: "Audit log" },
        ]} />
      </div>

      {tab === "paid_twice" && (
        <>
          <div className="mt-5">
            <Hero label="Paid twice this year" cents={f.overpaid_cad_cents} breakdown={f.overpaid_breakdown}
              meta={recovered
                ? <span><Money cents={recovered} /> recovered · <Money cents={f.to_recover_cad_cents} /> to go</span>
                : <span>{paidTwice} {plural(paidTwice, "double payment", "double payments")} to get back from vendors</span>} />
          </div>
          {scheduledTwice.map((d) => (
            <Notice key={d.key} tone="warning" title={`About to pay ${d.vendor_name} #${d.invoice_number} twice`}>
              {d.payment_ids.join(" and ")} are both scheduled. <Link to="/payments?tab=going" className="strong">Stop one on Payments</Link>
            </Notice>
          ))}
          <div className="mt-5">
            <DataTable label="Double payments to get back" columns={recoveryColumns} rows={recoveries.data} loading={!recoveries.data}
              rowKey={(r) => r.key} onOpen={(r) => setOpenKey(r.key)} />
          </div>
          <RecoveryDrawer item={recoveries.data?.find((r) => r.key === openKey) ?? null} onClose={() => setOpenKey(null)} onChanged={reload} />
        </>
      )}

      {tab === "tax" && (
        <>
          <div className="mt-5">
            <Hero label="Tax we can't claim back" cents={f.tax_at_risk_cents} breakdown={f.tax_at_risk_breakdown}
              meta={<span>if we pay {f.tax_invoice_count} {plural(f.tax_invoice_count, "invoice", "invoices")} as they are</span>} />
          </div>
          <div className="mt-5">
            <DataTable label="Invoices to fix" columns={taxColumns} rows={f.tax_at_risk} rowKey={(t) => `${t.invoice_id}-${t.code}`}
              to={(t) => `/invoices/${t.invoice_id}`} empty={<EmptyState title="Every tax credit is safe" />} />
          </div>
        </>
      )}

      {tab === "other" && (
        <>
          <Section title="Self-approvals" first>
            <DataTable label="Self-approvals" columns={selfColumns} rows={f.self_approvals} rowKey={(s) => s.invoice_id}
              to={(s) => `/invoices/${s.invoice_id}`} />
          </Section>
          <Section title="Split invoices">
            <DataTable label="Split invoices" columns={splitColumns} rows={f.split_invoices} rowKey={(s) => s.invoice_ids.join()}
              to={(s) => `/invoices/${s.invoice_ids[0]}`} />
          </Section>
        </>
      )}

      {tab === "log" && (
        <div className="mt-5">
          <DataTable label="Audit log, newest first" columns={logColumns} rows={log.data} loading={!log.data}
            rowKey={(e) => String(e.event_id)} to={linkFor} />
        </div>
      )}
    </Page>
  );
}

function RecoveryDrawer({ item, onClose, onChanged }: { item: Recovery | null; onClose: () => void; onChanged: () => void }) {
  const run = useRunner();
  const step = (s: "request" | "recovered", done: string) =>
    run(() => send("POST", `/recoveries/${encodeURIComponent(item!.key)}/${s}`), done, onChanged);
  return (
    <Drawer open={!!item} onClose={onClose} size={540} title={null}>
      {item && (
        <div>
          <EntityHead avatar={<Avatar name={item.vendor_name} size="lg" />} title={<h2 className="drawer-title m-0">{item.vendor_name}</h2>}
            sub={`Invoice #${item.invoice_number}`} />
          <Hero label="Paid too much" cents={item.overpaid_cad_cents}
            meta={<Pill tone={RECOVERY[item.status].tone}>{RECOVERY[item.status].label}</Pill>} />

          <Section title="What we paid">
            <div className="list">
              {item.lines.map((l) => (
                <Row key={l.ref} title={l.method} sub={`${l.ref} · ${longDate(l.date)}`} end={<Money cents={l.amount_cad_cents} />} />
              ))}
            </div>
            <div className="small mt-2"><Link to={`/invoices/${item.invoice_ids[0]}`} className="strong">Open the invoice</Link></div>
          </Section>

          {item.status === "to_recover" ? (
            <Section title="Ask for it back">
              <Draft text={item.letter} to={item.vendor_email ?? undefined}
                subject={`Refund request: invoice ${item.invoice_number} paid twice`}
                actions={<ActionButton size="middle" perm={item.can_update} onRun={() => step("request", "Refund requested")}>
                  Mark refund requested</ActionButton>} />
            </Section>
          ) : (
            <Section title="Progress">
              <div className="checks">
                <Check tone="positive" meta={item.requested_at ? instant(item.requested_at) : undefined}>
                  Refund requested{item.requested_by_name ? ` by ${item.requested_by_name}` : ""}
                </Check>
                {item.status === "recovered" ? (
                  <Check tone="positive" meta={item.recovered_at ? instant(item.recovered_at) : undefined}>
                    Money back{item.recovered_by_name ? `, recorded by ${item.recovered_by_name}` : ""}
                  </Check>
                ) : (
                  <Check tone="warning">Waiting for the refund, or a deduction on our next payment</Check>
                )}
              </div>
              {item.status === "requested" && (
                <div className="panel-actions">
                  <ActionButton perm={item.can_update} onRun={() => step("recovered", "Recorded as recovered")}>Record money received</ActionButton>
                </div>
              )}
            </Section>
          )}
        </div>
      )}
    </Drawer>
  );
}
