import { Segmented } from "antd";
import { useSearchParams } from "react-router";
import type { AuditEvent, Findings } from "../api";
import { Avatar, Hero, Loading, Page, PageTitle, Pill, Row, Section } from "../components/ui";
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
  "vendor.release_hold": "Released a vendor hold", "vendor.bank_change_requested": "Recorded a bank change request",
  "vendor.bank_change_confirmed": "Verified a bank change by phone", "vendor.bank_change_rejected": "Vendor denied a bank change",
};

const KIND_WORDS = { paid_twice: "Paid twice", about_to_pay_twice: "About to pay twice", paid_by_ap_and_card: "Paid by AP and on a card" };

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "findings";
  const log = useApi<AuditEvent[]>(tab === "log" ? "/audit" : null);
  const findings = useApi<Findings>(tab === "findings" ? "/findings" : null);

  return (
    <Page>
      <PageTitle title="Activity" subtitle="Who did what, and what went wrong. The log can't be edited or deleted, not even by an admin." />
      <div className="section" style={{ marginTop: 28 }}>
        <Segmented size="large" value={tab} onChange={(v) => setParams({ tab: String(v) })}
          options={[{ value: "findings", label: "Audit findings" }, { value: "log", label: "Audit log" }]} />
      </div>

      {tab === "findings" && (!findings.data ? <Loading error={findings.error} /> : (
        <>
          <div className="section" style={{ marginTop: 28 }}>
            <Hero label="Paid twice this year, to recover" value={money(findings.data.overpaid_cad_cents)}
              caption={`${findings.data.double_payments.filter((f) => f.kind !== "about_to_pay_twice").length} double payments found in the history`} />
          </div>
          <Section title="Double payments" caption="Same invoice paid more than once: twice through AP, or through AP and on an employee card.">
            <div className="list">
              {findings.data.double_payments.map((f) => (
                <Row key={f.payment_ids.join()} to={`/invoices/${f.invoice_ids[0]}`} avatar={<Avatar name={f.vendor_name} />}
                  title={`${f.vendor_name} #${f.invoice_number}`} sub={f.message}
                  end={<><span className="row-amount">{money(f.overpaid_cad_cents)}</span>
                    <Pill tone={f.kind === "about_to_pay_twice" ? "warning" : "negative"}>{KIND_WORDS[f.kind]}</Pill></>} />
              ))}
            </div>
          </Section>
          <Section title="Self-approvals" caption="Approved by the person who requested it (not allowed, P07).">
            <div className="list">
              {findings.data.self_approvals.map((s) => (
                <Row key={s.invoice_id} to={`/invoices/${s.invoice_id}`} avatar={<Avatar name={s.full_name} />}
                  title={`${s.full_name} approved their own request`} sub={`${s.invoice_id} · ${s.vendor_name}`}
                  end={<span className="row-amount">{money(s.total_cad_cents)}</span>} />
              ))}
            </div>
          </Section>
          <Section title="Split invoices" caption="Several invoices days apart, each under $10,000, together over it (avoids the finance manager).">
            <div className="list">
              {findings.data.split_invoices.map((s) => (
                <Row key={s.invoice_ids.join()} to={`/invoices/${s.invoice_ids[0]}`} avatar={<Avatar name={s.vendor_name} />}
                  title={s.vendor_name} sub={s.invoice_ids.join(", ")}
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
                avatar={<Avatar name={e.actor_name ?? "System"} dark={!e.actor_name} />}
                title={`${ACTION_WORDS[e.action] ?? e.action.replace(/[._]/g, " ")} · ${e.entity_type} ${e.entity_id}`}
                sub={[e.actor_name ?? "System", e.on_behalf_of_name && `on behalf of ${e.on_behalf_of_name}`, instant(e.created_at), e.reason]
                  .filter(Boolean).join(" · ")} />
            ))}
          </div>
        </Section>
      ))}
    </Page>
  );
}
