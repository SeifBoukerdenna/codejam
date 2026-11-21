import { useSearchParams } from "react-router";
import type { AuditEvent, Findings } from "../api";
import { Avatar, Chips, Hero, Loading, Page, PageTitle, Panel, Pill, Row, Section, Stat } from "../components/ui";
import { instant, money } from "../format";
import { useApi } from "../session";

// Two things an auditor needs: what went wrong in the past (findings), and who did what (the log).

const ACTION_WORDS: Record<string, string> = {
  "system.seed": "Loaded the Brim dataset", "email.sorted": "Sorted an email", "document.received": "Received a document",
  "document.read_failed": "Couldn't read a document", "invoice.create": "Read an invoice", "invoice.submit": "Sent for approval",
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
};
const KIND_WORDS = { paid_twice: "Paid twice", about_to_pay_twice: "Scheduled twice", paid_by_ap_and_card: "AP + card" };
type Tab = "findings" | "log";

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "findings";
  const log = useApi<AuditEvent[]>(tab === "log" ? "/audit" : null);
  const findings = useApi<Findings>("/findings");
  const f = findings.data;

  const rail = f && (
    <Panel title="Findings">
      <Stat label="Double payments" value={f.double_payments.filter((d) => d.kind !== "about_to_pay_twice").length} />
      <Stat label="Scheduled twice" value={f.double_payments.filter((d) => d.kind === "about_to_pay_twice").length} />
      <Stat label="Self-approvals" value={f.self_approvals.length} />
      <Stat label="Split invoices" value={f.split_invoices.length} />
      <p className="small muted" style={{ margin: "12px 0 0" }}>The audit log is append-only: the database refuses any edit or delete.</p>
    </Panel>
  );

  return (
    <Page rail={rail ?? undefined}>
      <PageTitle title="Activity" />
      <div style={{ marginTop: 22 }}>
        <Chips<Tab> value={tab} onChange={(v) => setParams({ tab: v })}
          options={[{ value: "findings", label: "Audit findings" }, { value: "log", label: "Audit log" }]} />
      </div>

      {tab === "findings" && (!f ? <Loading error={findings.error} /> : (
        <>
          <div style={{ marginTop: 30 }}>
            <Hero label="Paid twice this year" value={money(f.overpaid_cad_cents)} meta={<span>to recover from vendors</span>} />
          </div>
          <Section title="Double payments">
            <div className="list">
              {f.double_payments.map((d) => (
                <Row key={d.payment_ids.join()} to={`/invoices/${d.invoice_ids[0]}`} avatar={<Avatar name={d.vendor_name} />}
                  title={`${d.vendor_name} · #${d.invoice_number}`} sub={d.payment_ids.join(" + ")}
                  end={<><span className="row-amount">{money(d.overpaid_cad_cents)}</span>
                    <Pill tone={d.kind === "about_to_pay_twice" ? "warning" : "negative"}>{KIND_WORDS[d.kind]}</Pill></>} />
              ))}
            </div>
          </Section>
          <Section title="Self-approvals">
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
      ))}

      {tab === "log" && (!log.data ? <Loading error={log.error} /> : (
        <Section title="Latest">
          <div className="list">
            {log.data.map((e) => (
              <Row key={e.event_id}
                to={e.entity_type === "invoice" ? `/invoices/${e.entity_id}` : e.entity_type === "vendor" ? `/vendors/${e.entity_id}` : undefined}
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
