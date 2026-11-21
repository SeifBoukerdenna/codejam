import { Link, useSearchParams } from "react-router";
import type { Findings, InvoiceRow, PaymentRow as Payment } from "../api";
import PaymentRow from "../components/PaymentRow";
import { Avatar, Chips, Empty, Hero, Loading, Notice, Page, PageTitle, Panel, Row, Section, Stat } from "../components/ui";
import { money, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

type Summary = Record<string, { count: number; total_cad_cents: number; next_date: string | null }>;
type Tab = "approved" | "prepared" | "held" | "going" | "outstanding" | "settled";

// Tabs follow the money: approved → prepared (to release) → going out → paid. Held sits beside them.
const TABS: { key: Tab; label: string; hero: string; statuses: string[] }[] = [
  { key: "approved", label: "Ready to pay", hero: "Approved, not paid yet", statuses: [] },
  { key: "prepared", label: "To release", hero: "Waiting to be released", statuses: ["prepared"] },
  { key: "held", label: "Held", hero: "On hold", statuses: ["held"] },
  { key: "going", label: "Going out", hero: "Going out", statuses: ["released", "scheduled"] },
  { key: "outstanding", label: "Uncashed cheques", hero: "Cheques not cashed yet", statuses: ["outstanding"] },
  { key: "settled", label: "Paid", hero: "Paid", statuses: ["settled"] },
];

export default function Payments() {
  const { today } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get("tab")) ?? TABS[1];
  const isInvoices = tab.key === "approved";
  const { data, error } = useApi<{ payments: Payment[]; summary: Summary; about_to_pay_twice: Findings["double_payments"] }>(
    `/payments?status=${(isInvoices ? ["prepared"] : tab.statuses).join(",")}`);
  const approved = useApi<InvoiceRow[]>("/invoices?status=approved");
  if (!data || !approved.data) return <Loading error={error ?? approved.error} />;

  const toPay = approved.data.filter((i) => !i.is_credit_note);
  const credits = approved.data.filter((i) => i.is_credit_note);
  const sum = (statuses: string[]) => statuses.reduce((acc, s) => ({
    count: acc.count + (data.summary[s]?.count ?? 0), total: acc.total + (data.summary[s]?.total_cad_cents ?? 0) }), { count: 0, total: 0 });
  const count = (t: (typeof TABS)[number]) => (t.key === "approved" ? toPay.length : sum(t.statuses).count);
  const hero = isInvoices ? { count: toPay.length, total: toPay.reduce((a, i) => a + (i.total_cad_cents ?? 0), 0) } : sum(tab.statuses);
  const going = sum(["prepared", "released", "scheduled"]);

  const rail = (
    <>
      {data.about_to_pay_twice.map((f) => (
        <div key={f.payment_ids.join()} className="banner negative" style={{ marginTop: 0 }}>
          <div>
            <div className="banner-title">About to pay {f.vendor_name} twice</div>
            <div className="banner-body">#{f.invoice_number}: {f.payment_ids.join(" and ")} are both scheduled.
              Stop one: {f.invoice_ids.map((id) => <Link key={id} to={`/invoices/${id}`} style={{ fontWeight: 600, marginRight: 6 }}>{id}</Link>)}</div>
          </div>
        </div>
      ))}
      <Panel title="Money going out">
        <Stat label="Waiting to be released" value={money(data.summary.prepared?.total_cad_cents ?? 0)} />
        <Stat label="Released or scheduled" value={money(sum(["released", "scheduled"]).total)} />
        <Stat label="On hold" value={money(data.summary.held?.total_cad_cents ?? 0)} />
        <div className="panel-stat" style={{ borderTop: "1px solid var(--surface-2)", marginTop: 6, paddingTop: 10 }}>
          <span>Total</span><span>{money(going.total)}</span>
        </div>
      </Panel>
      {credits.length > 0 && (
        <Panel title="Credits waiting">
          <div className="small muted">Deducted automatically from the next payment to {credits.map((c) => c.vendor_name).join(", ")}.</div>
        </Panel>
      )}
      <p className="small muted" style={{ margin: "4px 6px" }}>Simulated EFT, cheque and virtual card. No real money moves.</p>
    </>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="Payments" />
      <div style={{ marginTop: 22 }}>
        <Chips<Tab> value={tab.key} onChange={(key) => setParams({ tab: key })}
          options={TABS.map((t) => ({ value: t.key, label: t.label, count: count(t) }))} />
      </div>
      <div style={{ marginTop: 30 }}>
        <Hero label={tab.hero} value={money(hero.total)}
          meta={<span>{hero.count} {plural(hero.count, isInvoices ? "invoice" : "payment", isInvoices ? "invoices" : "payments")}
            {tab.key === "going" && data.summary.scheduled?.next_date ? ` · next ${shortDate(data.summary.scheduled.next_date, today)}` : ""}</span>} />
      </div>
      {data.about_to_pay_twice.length > 0 && tab.key === "going" && (
        <Notice tone="negative" title="One invoice is scheduled twice">See the panel on the right before anything goes out.</Notice>
      )}
      <Section title={tab.label}>
        {isInvoices ? (toPay.length === 0 ? <Empty title="Nothing waiting to be paid" /> : (
          <div className="list">
            {toPay.map((i) => (
              <Row key={i.invoice_id} to={`/invoices/${i.invoice_id}`} avatar={<Avatar name={i.vendor_name} />}
                title={i.vendor_name ?? "—"} sub={`Invoice ${i.vendor_invoice_number} · ${shortDate(i.invoice_date, today)}`}
                end={<span className="row-amount">{money(i.total_cents, i.currency)}</span>} />
            ))}
          </div>
        )) : data.payments.length === 0 ? <Empty title="Nothing here" /> : (
          <div className="list">{data.payments.map((p) => <PaymentRow key={p.payment_id} p={p} today={today} />)}</div>
        )}
      </Section>
    </Page>
  );
}
