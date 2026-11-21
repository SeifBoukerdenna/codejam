import { Button, Form, Input, Modal, Radio, Select } from "antd";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { send, type VendorDetail as Data } from "../api";
import { ReasonModal, useRunner } from "../components/actions";
import { Avatar, Hero, Loading, Notice, Page, Pill, Row, Section } from "../components/ui";
import { INVOICE_STATUS, METHOD, VENDOR_STATUS, longDate, money, plural, shortDate, statusOf } from "../format";
import { useApi, useSession } from "../session";

const CHANNEL: Record<string, string> = {
  phone_callback_verified: "by phone, confirmed by calling back",
  vendor_portal: "through the vendor portal",
  email_request: "by email",
  phone: "by phone",
};

function contractTerms(c: Data["contracts"][number]): string {
  const parts: string[] = [];
  if (c.monthly_fee_cents !== null) parts.push(`${money(c.monthly_fee_cents, c.currency)} per month`);
  if (c.hourly_rate_cap_cents !== null) parts.push(`up to ${money(c.hourly_rate_cap_cents, c.currency)}/hour`);
  if (c.fuel_surcharge_cap_pct !== null) parts.push(`fuel surcharge up to ${c.fuel_surcharge_cap_pct}%`);
  if (c.not_to_exceed_monthly_cents !== null) parts.push(`max ${money(c.not_to_exceed_monthly_cents, c.currency)}/month`);
  return parts.join(" · ");
}

export default function VendorDetail() {
  const { vendorId } = useParams();
  const { today } = useSession();
  const navigate = useNavigate();
  const run = useRunner();
  const { data, error, reload } = useApi<Data>(`/vendors/${vendorId}`);
  const [holding, setHolding] = useState(false);
  const [changing, setChanging] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  if (!data || data.vendor.vendor_id !== vendorId) return <Loading error={error} />;

  const v = data.vendor;
  const act = data.actions;
  const status = statusOf(VENDOR_STATUS, v.status);
  const pending = data.bank_changes.find((b) => b.pending);

  return (
    <Page>
      <button className="back-link" onClick={() => navigate(-1)}>← Back</button>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <Avatar name={v.legal_name} size="large" />
        <div>
          <h1 className="page-title" style={{ fontSize: 36, margin: 0 }}>{v.legal_name}</h1>
          <div className="hero-caption">{v.category} · {v.province_or_state ?? v.country} · {v.vendor_id}
            <Pill tone={status.tone}>{status.label}</Pill></div>
        </div>
      </div>

      <div className="section" style={{ marginTop: 24, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        {act.approve && (
          <Button type="primary" shape="round" size="large" disabled={!act.approve.allowed}
            onClick={() => run(() => send("POST", `/vendors/${v.vendor_id}/approve`), "Vendor approved", reload)}>
            Approve vendor
          </Button>
        )}
        {pending?.verify && (
          <Button type={act.approve ? "default" : "primary"} shape="round" size="large" disabled={!pending.verify.allowed}
            onClick={() => setVerifying(pending.change_id)}>Verify bank change by phone</Button>
        )}
        {act.hold?.allowed && <button className="text-button" onClick={() => setHolding(true)}>Put on hold</button>}
        {act.release_hold?.allowed && <button className="text-button"
          onClick={() => run(() => send("POST", `/vendors/${v.vendor_id}/hold`, { release: true }), "Hold released", reload)}>Release hold</button>}
        {act.request_bank_change?.allowed && <button className="text-button" onClick={() => setChanging(true)}>Change bank details</button>}
      </div>
      {act.approve && !act.approve.allowed && <p className="muted small">{act.approve.reason}</p>}
      {pending?.verify && !pending.verify.allowed && <p className="muted small">{pending.verify.reason}</p>}

      {pending && (
        <Notice tone="negative" title="Don't pay this vendor until the bank change is verified">
          The bank account was changed on {longDate(pending.changed_at)} {CHANNEL[pending.request_channel] ?? pending.request_channel}
          {pending.changed_by_name ? ` (entered by ${pending.changed_by_name})` : ""}, and nobody has confirmed it by calling the
          vendor. Someone else must call them at the number on file from before the change. Payments stay on hold until then.
        </Notice>
      )}
      {v.status === "pending_review" && (
        <Notice tone="warning" title="This vendor is still being reviewed">
          Its invoices need an extra finance manager approval (P05) and can't be paid until a finance manager approves it.
        </Notice>
      )}
      {v.status === "on_hold" && <Notice tone="negative" title="This vendor is on hold">
        {v.status_reason ? `Reason: ${v.status_reason}. ` : ""}Nothing can be approved or paid for it.</Notice>}
      {data.lookalike_of && (
        <Notice tone="negative" title={`Looks like ${data.lookalike_of.legal_name}, but isn't`}>
          Similar name to <Link to={`/vendors/${data.lookalike_of.vendor_id}`}>{data.lookalike_of.legal_name}</Link>, which we've
          paid {data.lookalike_of.payments} times, with {data.lookalike_of.reasons.filter((r) => r.startsWith("different")).join(", ")}.
          Treat as a possible impersonation.
        </Notice>
      )}
      {data.similar.filter((s) => s.kind === "duplicate").map((s) => (
        <Notice key={s.vendor_id} tone="warning" title={`Possibly the same company as ${s.legal_name} (${s.vendor_id})`}>
          {s.reasons.join(", ")}. Duplicate vendor records let the same invoice be paid twice under two names.{" "}
          <Link to={`/vendors/${s.vendor_id}`}>Open {s.vendor_id}</Link>
        </Notice>
      ))}

      <div className="section">
        <Hero label="Paid this year" value={money(data.paid_this_year.cents)}
          caption={`${data.paid_this_year.count} ${plural(data.paid_this_year.count, "payment", "payments")}`} />
      </div>

      <Section title="Details">
        <dl className="kv">
          <dt>Pays by</dt><dd>{METHOD[v.preferred_payment_method ?? ""] ?? "—"}{v.payment_terms_days ? ` · net ${v.payment_terms_days} days` : ""}</dd>
          <dt>Bank account</dt>
          <dd>{v.bank_account_last4 ? `Inst. ${v.bank_institution} · Transit ${v.bank_transit} · ••••${v.bank_account_last4}` : "None on file"}</dd>
          <dt>GST/HST number</dt><dd>{v.gst_hst_number ?? "None on file"}</dd>
          {v.qst_number && <><dt>QST number</dt><dd>{v.qst_number}</dd></>}
          <dt>Billing email</dt><dd>{v.ap_contact_email ?? "—"}</dd>
          <dt>Needs a PO</dt><dd>{v.requires_po ? "Yes" : "No"}</dd>
          <dt>Address</dt><dd>{v.address ?? "—"}</dd>
        </dl>
      </Section>

      {data.bank_changes.length > 0 && (
        <Section title="Bank account changes" caption="A change only counts once someone has called the vendor back to confirm it.">
          <div className="list">
            {data.bank_changes.map((b) => (
              <Row key={b.change_id}
                title={`${b.old_account_last4 ? `••••${b.old_account_last4}` : "none"} → ••••${b.new_account_last4}`}
                sub={`${shortDate(b.changed_at, today)} · ${CHANNEL[b.request_channel] ?? b.request_channel}` +
                  (b.changed_by_name ? ` · entered by ${b.changed_by_name}` : "") +
                  (b.callback_by_name ? ` · ${b.callback_by_name} called ${b.callback_phone}` : "")}
                end={b.verified_by_callback ? <Pill tone="positive">Verified</Pill>
                  : b.callback_outcome === "rejected" ? <Pill tone="negative">Vendor denied it</Pill>
                    : <Pill tone="negative">Not verified</Pill>} />
            ))}
          </div>
        </Section>
      )}

      {data.contracts.length > 0 && (
        <Section title="Contracts">
          <div className="list">
            {data.contracts.map((c) => (
              <Row key={c.contract_id} title={`${c.contract_id} · ${c.description}`}
                sub={`${contractTerms(c)} · ends ${shortDate(c.end_date, today)}`}
                end={c.status === "active" ? <Pill tone="positive">Active</Pill> : <Pill tone="negative">Expired</Pill>} />
            ))}
          </div>
        </Section>
      )}

      {data.purchase_orders.length > 0 && (
        <Section title="Purchase orders" caption="What's left is the PO amount minus invoices charged to it, tax included.">
          <div className="list">
            {data.purchase_orders.map((po) => (
              <Row key={po.po_id} title={`${po.po_id} · ${po.status.replace("_", " ")}`}
                sub={`${po.description} · issued ${shortDate(po.issue_date, today)}`}
                end={<><span className="row-amount">{money(po.total_amount_cents - po.invoiced_cents)} left</span>
                  <span className="muted small">of {money(po.total_amount_cents)}</span></>} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Invoices">
        <div className="list">
          {data.invoices.map((inv) => {
            const s = statusOf(INVOICE_STATUS, inv.status);
            return (
              <Row key={inv.invoice_id} to={`/invoices/${inv.invoice_id}`}
                title={`${inv.is_credit_note ? "Credit note" : "Invoice"} ${inv.vendor_invoice_number ?? inv.invoice_id}`}
                sub={`${shortDate(inv.invoice_date, today)} · ${inv.invoice_id}`}
                end={<><span className="row-amount">{money(inv.total_cents, inv.currency)}</span>
                  {inv.status !== "paid" && <Pill tone={s.tone}>{s.label}</Pill>}</>} />
            );
          })}
        </div>
      </Section>

      <ReasonModal open={holding} title={`Put ${v.legal_name} on hold?`} okText="Put on hold"
        placeholder="e.g. Bank details look suspicious" onClose={() => setHolding(false)}
        onSubmit={(reason) => run(() => send("POST", `/vendors/${v.vendor_id}/hold`, { reason }), "Vendor on hold", reload)} />
      <BankChangeModal open={changing} vendorId={v.vendor_id} onClose={() => setChanging(false)} onDone={reload} />
      <CallbackModal changeId={verifying} onClose={() => setVerifying(null)} onDone={reload} />
    </Page>
  );
}

function BankChangeModal({ open, vendorId, onClose, onDone }: { open: boolean; vendorId: string; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const run = useRunner();
  return (
    <Modal open={open} title="New bank details" okText="Record the request" onCancel={onClose} destroyOnHidden
      okButtonProps={{ shape: "round" }} cancelButtonProps={{ shape: "round" }}
      onOk={() => form.validateFields().then((values) => run(() => send("POST", `/vendors/${vendorId}/bank-changes`, values),
        "Recorded. Payments are held until someone verifies it by phone.", onDone).then((ok) => ok && onClose()))}>
      <p className="muted">Nothing changes on the vendor yet. The new account only takes effect after a callback.</p>
      <Form form={form} layout="vertical" initialValues={{ channel: "email_request" }} requiredMark={false}>
        <div style={{ display: "flex", gap: 12 }}>
          <Form.Item name="institution" label="Institution" rules={[{ required: true, len: 3 }]} style={{ width: 110 }}><Input /></Form.Item>
          <Form.Item name="transit" label="Transit" rules={[{ required: true, len: 5 }]} style={{ width: 130 }}><Input /></Form.Item>
          <Form.Item name="account" label="Account" rules={[{ required: true }]} style={{ flex: 1 }}><Input /></Form.Item>
        </div>
        <Form.Item name="channel" label="How the request came in">
          <Select options={[{ value: "email_request", label: "Email" }, { value: "phone", label: "Phone" },
            { value: "vendor_portal", label: "Vendor portal" }]} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CallbackModal({ changeId, onClose, onDone }: { changeId: string | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const run = useRunner();
  return (
    <Modal open={!!changeId} title="Verify by calling the vendor" okText="Save the call" onCancel={onClose} destroyOnHidden
      okButtonProps={{ shape: "round" }} cancelButtonProps={{ shape: "round" }}
      onOk={() => form.validateFields().then((values) => run(() => send("POST", `/bank-changes/${changeId}/verify`, values),
        values.outcome === "confirmed" ? "Verified. The new details are in effect." : "Recorded: the vendor denied it.", onDone)
        .then((ok) => ok && onClose()))}>
      <p className="muted">Call the number we had on file <b>before</b> the change, never one from the email or invoice
        that asked for it. Ask the vendor to confirm the new account.</p>
      <Form form={form} layout="vertical" initialValues={{ outcome: "confirmed" }} requiredMark={false}>
        <Form.Item name="phone" label="Number you called" rules={[{ required: true }]}><Input placeholder="e.g. 604-555-0142" /></Form.Item>
        <Form.Item name="outcome" label="What the vendor said">
          <Radio.Group options={[{ value: "confirmed", label: "Confirmed the change" }, { value: "rejected", label: "Didn't ask for it" }]} />
        </Form.Item>
        <Form.Item name="note" label="Notes"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  );
}
