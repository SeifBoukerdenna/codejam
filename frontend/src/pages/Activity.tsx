import { Button, Drawer } from "antd";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { send, type AuditEvent, type Findings, type Recovery } from "../api";
import { useRunner } from "../components/actions";
import { Avatar, Check, Chips, Draft, Empty, Hero, Loading, Notice, Page, PageTitle, Panel, Pill, Row, Section, Stat } from "../components/ui";
import { INVOICE_STATUS, instant, longDate, money, plural, statusOf, type Tone } from "../format";
import { useApi, useSession } from "../session";

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
  "payment.settle": "Bank confirmed a payment", "payment.cancel": "Stopped a payment", "credit_note.applied": "Deducted a credit note",
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
  requested: { label: "Refund requested", tone: "neutral" },
  recovered: { label: "Recovered", tone: "positive" },
};
const TAX_PROBLEM: Record<string, string> = {
  WRONG_TAX_FOR_PROVINCE: "Wrong tax for the province", PST_ON_SERVICES: "PST charged on services",
  UNEXPECTED_TAX: "Tax that doesn't apply", GST_NUMBER_MISSING: "No GST/HST number", QST_NUMBER_MISSING: "No QST number",
};

type Tab = "paid_twice" | "tax" | "other" | "log";

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "paid_twice";
  const findings = useApi<Findings>("/findings");
  const recoveries = useApi<Recovery[]>(tab === "paid_twice" ? "/recoveries" : null);
  const log = useApi<AuditEvent[]>(tab === "log" ? "/audit" : null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const f = findings.data;
  if (!f) return <Loading error={findings.error} />;

  const scheduledTwice = f.double_payments.filter((d) => d.kind === "about_to_pay_twice");
  const paidTwice = f.double_payments.length - scheduledTwice.length;
  const recs = recoveries.data ?? [];
  const sumBy = (s: Recovery["status"]) => recs.filter((r) => r.status === s).reduce((n, r) => n + r.overpaid_cad_cents, 0);
  const taxBy = f.tax_at_risk.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.code]: (acc[t.code] ?? 0) + t.at_risk_cents }), {});
  const taxInvoices = new Set(f.tax_at_risk.map((t) => t.invoice_id)).size;
  const reload = () => { findings.reload(); recoveries.reload(); };

  const rail = {
    paid_twice: (
      <Panel title="Getting it back">
        <Stat label="To recover" value={money(sumBy("to_recover"))} />
        <Stat label="Refund requested" value={money(sumBy("requested"))} />
        <Stat label="Recovered" value={money(sumBy("recovered"))} />
        <div className="progress"><div style={{ width: `${f.overpaid_cad_cents ? (f.recovered_cad_cents / f.overpaid_cad_cents) * 100 : 0}%`, background: "var(--green)" }} /></div>
      </Panel>
    ),
    tax: (
      <Panel title="By problem">
        {Object.entries(taxBy).sort((a, b) => b[1] - a[1]).map(([code, cents]) => (
          <Stat key={code} label={TAX_PROBLEM[code] ?? code} value={money(cents)} />
        ))}
        {!f.tax_at_risk.length && <div className="muted">Nothing at risk.</div>}
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
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>Append-only: the database refuses any edit or delete.</p>
      </Panel>
    ),
  }[tab];

  return (
    <Page rail={rail}>
      <PageTitle title="Activity" />
      <div style={{ marginTop: 22 }}>
        <Chips<Tab> value={tab} onChange={(v) => setParams({ tab: v })} options={[
          { value: "paid_twice", label: "Paid twice" },
          { value: "tax", label: "Tax at risk" },
          { value: "other", label: "Other findings" },
          { value: "log", label: "Audit log" },
        ]} />
      </div>

      {tab === "paid_twice" && (
        <>
          <div style={{ marginTop: 30 }}>
            <Hero label="Paid twice this year" value={money(f.overpaid_cad_cents)}
              meta={f.recovered_cad_cents
                ? <span><b style={{ color: "var(--green)" }}>{money(f.recovered_cad_cents)}</b> recovered · {money(f.to_recover_cad_cents)} to go</span>
                : <span>{paidTwice} {plural(paidTwice, "double payment", "double payments")} to get back from vendors</span>} />
          </div>
          {scheduledTwice.map((d) => (
            <Notice key={d.key} tone="warning" title={`About to pay ${d.vendor_name} #${d.invoice_number} twice`}>
              {d.payment_ids.join(" and ")} are both scheduled. <Link to="/payments?tab=going" style={{ fontWeight: 600 }}>Stop one on Payments</Link>
            </Notice>
          ))}
          <Section title="Double payments">
            {!recoveries.data ? <p className="muted">Loading…</p> : (
              <div className="list">
                {recs.map((r) => (
                  <Row key={r.key} onClick={() => setOpenKey(r.key)} avatar={<Avatar name={r.vendor_name} />}
                    title={r.vendor_name} sub={`#${r.invoice_number} · ${HOW[r.kind]}`}
                    end={<><span className="row-amount">{money(r.overpaid_cad_cents)}</span>
                      <Pill tone={RECOVERY[r.status].tone}>{RECOVERY[r.status].label}</Pill></>} />
                ))}
              </div>
            )}
          </Section>
          <RecoveryDrawer item={recs.find((r) => r.key === openKey) ?? null} onClose={() => setOpenKey(null)} onChanged={reload} />
        </>
      )}

      {tab === "tax" && (
        <>
          <div style={{ marginTop: 30 }}>
            <Hero label="Tax we can't claim back" value={money(f.tax_at_risk_cents)}
              meta={<span>if we pay {taxInvoices} {plural(taxInvoices, "invoice", "invoices")} as they are</span>} />
          </div>
          <Section title="Invoices to fix">
            {f.tax_at_risk.length ? (
              <div className="list">
                {f.tax_at_risk.map((t) => (
                  <Row key={`${t.invoice_id}-${t.code}`} to={`/invoices/${t.invoice_id}`} avatar={<Avatar name={t.vendor_name} />}
                    title={`${t.vendor_name ?? "Unknown vendor"} · #${t.vendor_invoice_number ?? t.invoice_id}`} sub={t.fix}
                    end={<><span className="row-amount">{money(t.at_risk_cents, t.currency)}</span>
                      <span className="small muted">{statusOf(INVOICE_STATUS, t.status).label}</span></>} />
                ))}
              </div>
            ) : <Empty title="Every tax credit is safe" />}
          </Section>
        </>
      )}

      {tab === "other" && (
        <>
          <Section title="Self-approvals" first>
            <div className="list">
              {f.self_approvals.map((s) => (
                <Row key={s.invoice_id} to={`/invoices/${s.invoice_id}`} avatar={<Avatar name={s.full_name} round />}
                  title={`${s.full_name} approved their own request`} sub={`${s.invoice_id} · ${s.vendor_name}`}
                  end={<span className="row-amount">{money(s.total_cad_cents)}</span>} />
              ))}
            </div>
          </Section>
          <Section title="Split invoices">
            <div className="list">
              {f.split_invoices.map((s) => (
                <Row key={s.invoice_ids.join()} to={`/invoices/${s.invoice_ids[0]}`} avatar={<Avatar name={s.vendor_name} />}
                  title={s.vendor_name} sub={s.invoice_ids.join(" · ")}
                  end={<span className="row-amount">{money(s.combined_cad_cents)}</span>} />
              ))}
            </div>
          </Section>
        </>
      )}

      {tab === "log" && (!log.data ? <Loading error={log.error} /> : (
        <Section title="Latest" first>
          <div className="list">
            {log.data.map((e) => (
              <Row key={e.event_id}
                to={e.entity_type === "invoice" ? `/invoices/${e.entity_id}` : e.entity_type === "vendor" ? `/vendors/${e.entity_id}`
                  : e.entity_type === "bank_line" ? "/bank?tab=done" : undefined}
                avatar={<Avatar name={e.actor_name ?? "System"} round dark={!e.actor_name} />}
                title={`${ACTION_WORDS[e.action] ?? e.action.replace(/[._]/g, " ")}${e.entity_type !== "database" ? ` · ${e.entity_id}` : ""}`}
                sub={[e.actor_name ?? "System", e.on_behalf_of_name && `for ${e.on_behalf_of_name}`, e.reason].filter(Boolean).join(" · ")}
                end={<span className="small muted">{instant(e.created_at)}</span>} />
            ))}
          </div>
        </Section>
      ))}
    </Page>
  );
}

function RecoveryDrawer({ item, onClose, onChanged }: { item: Recovery | null; onClose: () => void; onChanged: () => void }) {
  const { user } = useSession();
  const run = useRunner();
  const canAct = user && ["ap_clerk", "finance_manager", "controller_admin"].includes(user.role) && user.status === "active";
  const step = (s: "request" | "recovered", done: string) =>
    run(() => send("POST", `/recoveries/${encodeURIComponent(item!.key)}/${s}`), done, onChanged);
  return (
    <Drawer open={!!item} onClose={onClose} size={540} title={null}>
      {item && (
        <div>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <Avatar name={item.vendor_name} size="lg" />
            <div style={{ minWidth: 0 }}>
              <h2 className="drawer-title" style={{ margin: 0 }}>{item.vendor_name}</h2>
              <div className="muted small">Invoice #{item.invoice_number}</div>
            </div>
          </div>
          <div style={{ marginTop: 22 }}>
            <Hero label="Paid too much" value={money(item.overpaid_cad_cents)}
              meta={<Pill tone={RECOVERY[item.status].tone}>{RECOVERY[item.status].label}</Pill>} />
          </div>

          <Section title="What we paid">
            <div className="list">
              {item.lines.map((l) => (
                <Row key={l.ref} title={l.method} sub={`${l.ref} · ${longDate(l.date)}`}
                  end={<span className="row-amount">{money(l.amount_cad_cents)}</span>} />
              ))}
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              <Link to={`/invoices/${item.invoice_ids[0]}`} style={{ fontWeight: 600 }}>Open the invoice</Link>
            </div>
          </Section>

          {item.status === "to_recover" ? (
            <Section title="Ask for it back">
              <Draft text={item.letter} to={item.vendor_email ?? undefined}
                subject={`Refund request: invoice ${item.invoice_number} paid twice`}
                actions={canAct && (
                  <Button type="primary" shape="round" onClick={() => step("request", "Refund requested")}>
                    Mark refund requested
                  </Button>
                )} />
            </Section>
          ) : (
            <Section title="Progress">
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
              {item.status === "requested" && canAct && (
                <div className="panel-actions">
                  <Button type="primary" shape="round" size="large" onClick={() => step("recovered", "Recorded as recovered")}>
                    Record money received
                  </Button>
                </div>
              )}
            </Section>
          )}
        </div>
      )}
    </Drawer>
  );
}
