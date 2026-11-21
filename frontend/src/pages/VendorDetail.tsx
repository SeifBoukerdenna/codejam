import { useNavigate, useParams } from "react-router";
import type { VendorDetail as Data } from "../api";
import { Avatar, Hero, Loading, Notice, Page, Pill, Row, Section } from "../components/ui";
import { INVOICE_STATUS, METHOD, VENDOR_STATUS, longDate, money, plural, shortDate, statusOf } from "../format";
import { useApi, useSession } from "../session";

const CHANNEL: Record<string, string> = {
  phone_callback_verified: "by phone, confirmed by calling back",
  vendor_portal: "through the vendor portal",
  email_request: "by email",
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
  const { data, error } = useApi<Data>(`/vendors/${vendorId}`);
  if (!data || data.vendor.vendor_id !== vendorId) return <Loading error={error} />;

  const v = data.vendor;
  const status = statusOf(VENDOR_STATUS, v.status);
  const unverified = data.bank_changes.find((b) => !b.verified_by_callback);

  return (
    <Page>
      <button className="back-link" onClick={() => navigate(-1)}>← Back</button>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <Avatar name={v.legal_name} size="large" />
        <div>
          <h1 className="page-title" style={{ fontSize: 36, margin: 0 }}>{v.legal_name}</h1>
          <div className="hero-caption">
            {v.category} · {v.province_or_state ?? v.country}
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
        </div>
      </div>

      {unverified && (
        <Notice tone="negative" title="Don't pay this vendor until the bank change is verified">
          The bank account was changed on {longDate(unverified.changed_at)} {CHANNEL[unverified.request_channel] ?? unverified.request_channel},
          and nobody confirmed it by calling the vendor. Call them at the number on file from before the change
          to verify it.
        </Notice>
      )}
      {v.status === "pending_review" && (
        <Notice tone="warning" title="This vendor is still being reviewed">
          Invoices can be entered, but they need an extra finance manager approval and can't be paid until the
          vendor is approved.
        </Notice>
      )}
      {v.status === "on_hold" && (
        <Notice tone="negative" title="This vendor is on hold">Nothing can be paid to this vendor.</Notice>
      )}

      <div className="section">
        <Hero
          label="Paid this year"
          value={money(data.paid_this_year.cents)}
          caption={`${data.paid_this_year.count} ${plural(data.paid_this_year.count, "payment", "payments")}`}
        />
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
        <Section title="Bank account changes">
          <div className="list">
            {data.bank_changes.map((b) => (
              <Row
                key={b.change_id}
                title={`••••${b.old_account_last4} → ••••${b.new_account_last4}`}
                sub={`${shortDate(b.changed_at, today)} · ${CHANNEL[b.request_channel] ?? b.request_channel}${b.changed_by_name ? ` · entered by ${b.changed_by_name}` : ""}`}
                end={b.verified_by_callback ? <Pill tone="positive">Verified</Pill> : <Pill tone="negative">Not verified</Pill>}
              />
            ))}
          </div>
        </Section>
      )}

      {data.contracts.length > 0 && (
        <Section title="Contracts">
          <div className="list">
            {data.contracts.map((c) => (
              <Row
                key={c.contract_id}
                title={c.description}
                sub={`${contractTerms(c)} · ends ${shortDate(c.end_date, today)}`}
                end={c.status === "active" ? <Pill tone="positive">Active</Pill> : <Pill tone="negative">Expired</Pill>}
              />
            ))}
          </div>
        </Section>
      )}

      {data.purchase_orders.length > 0 && (
        <Section title="Purchase orders">
          <div className="list">
            {data.purchase_orders.map((po) => (
              <Row
                key={po.po_id}
                title={po.po_id}
                sub={`${po.description} · issued ${shortDate(po.issue_date, today)}`}
                end={
                  <>
                    <span className="row-amount">{money(po.total_amount_cents - po.invoiced_cents)} left</span>
                    <span className="muted small">of {money(po.total_amount_cents)}</span>
                  </>
                }
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Invoices">
        <div className="list">
          {data.invoices.map((inv) => {
            const s = statusOf(INVOICE_STATUS, inv.status);
            return (
              <Row
                key={inv.invoice_id}
                to={`/invoices/${inv.invoice_id}`}
                title={`Invoice ${inv.vendor_invoice_number ?? inv.invoice_id}`}
                sub={`${shortDate(inv.invoice_date, today)} · ${inv.invoice_id}`}
                end={
                  <>
                    <span className="row-amount">{money(inv.total_cents, inv.currency)}</span>
                    {inv.status !== "paid" && <Pill tone={s.tone}>{s.label}</Pill>}
                  </>
                }
              />
            );
          })}
        </div>
      </Section>
    </Page>
  );
}
