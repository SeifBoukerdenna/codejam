import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Radio, Select } from "antd";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { send, type VendorDetail as Data } from "../api";
import { ReasonModal, useRunner } from "../components/actions";
import { rememberVisit } from "../components/CommandPalette";
import { ActionButton, Avatar, EntityHead, Hero, Loading, Money, Notice, Page, Panel, Pill, Row, Section, Stat, Tiles } from "../components/ui";
import { INVOICE_STATUS, METHOD, VENDOR_STATUS, longDate, money, plural, shortDate, statusOf } from "../format";
import { useApi, useSession } from "../session";

const CHANNEL: Record<string, string> = {
  phone_callback_verified: "by phone, confirmed by callback", vendor_portal: "through the vendor portal",
  email_request: "by email", phone: "by phone",
};

function contractTerms(c: Data["contracts"][number]): string {
  const parts: string[] = [];
  if (c.monthly_fee_cents !== null) parts.push(`${money(c.monthly_fee_cents, c.currency)}/month`);
  if (c.hourly_rate_cap_cents !== null) parts.push(`≤ ${money(c.hourly_rate_cap_cents, c.currency)}/hour`);
  if (c.fuel_surcharge_cap_pct !== null) parts.push(`fuel ≤ ${c.fuel_surcharge_cap_pct}%`);
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
  const loaded = data && data.vendor.vendor_id === vendorId ? data.vendor : null;
  useEffect(() => {
    if (loaded) rememberVisit({ key: loaded.vendor_id, kind: "vendor", to: `/vendors/${loaded.vendor_id}`, title: loaded.legal_name,
      sub: `Vendor ${loaded.vendor_id} · ${loaded.category}` });
  }, [loaded?.vendor_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !loaded) return <Loading error={error} />;

  const v = data.vendor;
  const act = data.actions;
  const status = statusOf(VENDOR_STATUS, v.status);
  const pending = data.bank_changes.find((b) => b.pending);
  const primary = act.approve
    ? { label: "Approve vendor", perm: act.approve, onClick: () => run(() => send("POST", `/vendors/${v.vendor_id}/approve`), "Vendor approved", reload) }
    : pending?.verify ? { label: "Verify bank change by phone", perm: pending.verify, onClick: () => setVerifying(pending.change_id) } : null;

  const rail = (
    <>
      <Panel>
        <Pill tone={pending ? "negative" : status.tone}>{pending ? "Payments on hold" : status.label}</Pill>
        <div className="status-sentence">
          {pending ? "Bank change not verified" : v.status === "pending_review" ? "Waiting for a finance manager"
            : v.status === "on_hold" ? "Nothing can be paid" : "Can be paid"}
        </div>
        <div className="panel-actions">
          {primary && <ActionButton perm={primary.perm} onRun={primary.onClick}>{primary.label}</ActionButton>}
          {act.request_bank_change?.allowed && <Button className="soft" size="large" shape="round" onClick={() => setChanging(true)}>Change bank details</Button>}
          {act.hold?.allowed && <Button className="danger-soft" size="large" shape="round" onClick={() => setHolding(true)}>Put on hold</Button>}
          {act.release_hold?.allowed && <Button className="soft" size="large" shape="round"
            onClick={() => run(() => send("POST", `/vendors/${v.vendor_id}/hold`, { release: true }), "Hold released", reload)}>Release hold</Button>}
        </div>
      </Panel>
      <Panel title="Bank account">
        <Stat label="Institution" value={v.bank_institution ?? "—"} />
        <Stat label="Transit" value={v.bank_transit ?? "—"} />
        <Stat label="Account" value={v.bank_account_last4 ? `••••${v.bank_account_last4}` : "None"} />
        <Stat label="Pays by" value={METHOD[v.preferred_payment_method ?? ""] ?? "—"} />
      </Panel>
    </>
  );

  const head = (
    <>
      <button className="link-button mb-5" onClick={() => navigate(-1)}><ArrowLeftOutlined aria-hidden /> Back</button>
      <EntityHead avatar={<Avatar name={v.legal_name} size="lg" />} title={<h1 className="page-title">{v.legal_name}</h1>}
        sub={`${v.category} · ${v.province_or_state ?? v.country} · ${v.vendor_id}`} />

      <Hero label="Paid this year" cents={data.paid_this_year.cents}
        meta={<span>{data.paid_this_year.count} {plural(data.paid_this_year.count, "payment", "payments")}</span>} />
    </>
  );

  return (
    <Page rail={rail} railFirst head={head}>

      {pending && (
        <Notice tone="negative" title="Don't pay this vendor until the bank change is verified">
          Changed {longDate(pending.changed_at)} {CHANNEL[pending.request_channel] ?? pending.request_channel}
          {pending.changed_by_name ? `, entered by ${pending.changed_by_name}` : ""}. Someone else must call the vendor at the
          number on file from before the change.
        </Notice>
      )}
      {v.status === "on_hold" && v.status_reason && <Notice tone="negative" title="On hold">{v.status_reason}</Notice>}
      {data.lookalike_of && (
        <Notice tone="negative" title={`Looks like ${data.lookalike_of.legal_name}, but isn't`}>
          We've paid <Link to={`/vendors/${data.lookalike_of.vendor_id}`} className="strong">{data.lookalike_of.legal_name}</Link>{" "}
          {data.lookalike_of.payments} times. This one has a {data.lookalike_of.reasons.filter((r) => r.startsWith("different"))
            .map((r) => r.replace("different ", "")).join(", ")} that don't match.
        </Notice>
      )}
      {data.similar.filter((s) => s.kind === "duplicate").map((s) => (
        <Notice key={s.vendor_id} tone="warning" title={`Possibly the same company as ${s.legal_name}`}>
          {s.reasons.join(", ")}. <Link to={`/vendors/${s.vendor_id}`} className="strong">Open {s.vendor_id}</Link>
        </Notice>
      ))}

      <Section title="Details">
        <Tiles items={[
          { label: "GST/HST number", value: v.gst_hst_number ?? "None on file" },
          { label: "QST number", value: v.qst_number ?? "—" },
          { label: "Billing email", value: v.ap_contact_email ?? "—" },
          { label: "Payment terms", value: v.payment_terms_days ? `Net ${v.payment_terms_days} days` : "—" },
          { label: "Needs a purchase order", value: v.requires_po ? "Yes" : "No" },
          { label: "Address", value: v.address ?? "—" },
        ]} />
      </Section>

      {data.bank_changes.length > 0 && (
        <Section title="Bank changes">
          <div className="list">
            {data.bank_changes.map((b) => (
              <Row key={b.change_id} title={`${b.old_account_last4 ? `••••${b.old_account_last4}` : "none"} → ••••${b.new_account_last4}`}
                sub={`${shortDate(b.changed_at, today)} · ${CHANNEL[b.request_channel] ?? b.request_channel}` +
                  (b.callback_by_name ? ` · ${b.callback_by_name} called ${b.callback_phone}` : "")}
                end={b.verified_by_callback ? <Pill tone="positive">Verified</Pill>
                  : b.callback_outcome === "rejected" ? <Pill tone="negative">Denied</Pill> : <Pill tone="negative">Not verified</Pill>} />
            ))}
          </div>
        </Section>
      )}

      {data.contracts.length > 0 && (
        <Section title="Contracts">
          <div className="list">
            {data.contracts.map((c) => (
              <Row key={c.contract_id} title={c.description} sub={`${c.contract_id} · ${contractTerms(c)} · ends ${shortDate(c.end_date, today)}`}
                end={c.status === "active" ? <Pill tone="positive">Active</Pill> : <Pill tone="negative">Expired</Pill>} />
            ))}
          </div>
        </Section>
      )}

      {data.purchase_orders.length > 0 && (
        <Section title="Purchase orders">
          <div className="list">
            {data.purchase_orders.map((po) => (
              <Row key={po.po_id} title={po.po_id} sub={`${po.description} · ${po.status.replace("_", " ")}`}
                end={<><span className="row-amount"><Money cents={po.remaining_cents} /></span>
                  <span className="small muted">left of {money(po.total_amount_cents, "CAD", true)}</span></>} />
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
                end={<><span className="row-amount"><Money cents={inv.total_cents} currency={inv.currency} /></span>
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
      okButtonProps={{ shape: "round", size: "large" }} cancelButtonProps={{ shape: "round", size: "large", className: "soft" }}
      onOk={() => form.validateFields().then((values) => run(() => send("POST", `/vendors/${vendorId}/bank-changes`, values),
        "Recorded. Payments are held until someone verifies it by phone.", onDone).then((ok) => ok && onClose()))}>
      <p className="muted">Nothing changes until someone else verifies it by calling the vendor.</p>
      <Form form={form} layout="vertical" initialValues={{ channel: "email_request" }} requiredMark={false}>
        <div className="form-row">
          <Form.Item name="institution" label="Institution" rules={[{ required: true, len: 3 }]} className="field-sm"><Input /></Form.Item>
          <Form.Item name="transit" label="Transit" rules={[{ required: true, len: 5 }]} className="field-md"><Input /></Form.Item>
          <Form.Item name="account" label="Account" rules={[{ required: true }]}><Input /></Form.Item>
        </div>
        <Form.Item name="channel" label="How the request came in">
          <Select options={[{ value: "email_request", label: "Email" }, { value: "phone", label: "Phone" }, { value: "vendor_portal", label: "Vendor portal" }]} />
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
      okButtonProps={{ shape: "round", size: "large" }} cancelButtonProps={{ shape: "round", size: "large", className: "soft" }}
      onOk={() => form.validateFields().then((values) => run(() => send("POST", `/bank-changes/${changeId}/verify`, values),
        values.outcome === "confirmed" ? "Verified. The new details are live." : "Recorded: the vendor denied it.", onDone)
        .then((ok) => ok && onClose()))}>
      <p className="muted">Call the number we had on file <b>before</b> the change, never one from the email that asked for it.</p>
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
