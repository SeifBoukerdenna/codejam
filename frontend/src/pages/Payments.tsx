import { Segmented } from "antd";
import { Link, useSearchParams } from "react-router";
import type { Findings, InvoiceRow, PaymentRow as Payment } from "../api";
import PaymentRow from "../components/PaymentRow";
import { Avatar, Empty, Hero, Loading, Notice, Page, PageTitle, Row, Section } from "../components/ui";
import { money, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

type Summary = Record<string, { count: number; total_cad_cents: number; next_date: string | null }>;

// Tabs follow the money: approved -> prepared (to release) -> going out -> paid. Held sits beside them.
const TABS = [
  { key: "approved", label: "Ready to pay", hero: "Approved, not paid yet", statuses: [] as string[] },
  { key: "prepared", label: "To release", hero: "Waiting for a finance manager to release", statuses: ["prepared"] },
  { key: "held", label: "Held", hero: "Held: something must be fixed first", statuses: ["held"] },
  { key: "going", label: "Going out", hero: "Released or scheduled with the bank", statuses: ["released", "scheduled"] },
  { key: "outstanding", label: "Cheques not cashed", hero: "Sent by cheque, not cashed yet", statuses: ["outstanding"] },
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
  const sum = (statuses: string[]) => statuses.reduce(
    (acc, s) => ({ count: acc.count + (data.summary[s]?.count ?? 0), total: acc.total + (data.summary[s]?.total_cad_cents ?? 0) }),
    { count: 0, total: 0 });
  const count = (t: (typeof TABS)[number]) => (t.key === "approved" ? toPay.length : sum(t.statuses).count);
  const hero = isInvoices
    ? { count: toPay.length, total: toPay.reduce((a, i) => a + (i.total_cad_cents ?? 0), 0) }
    : sum(tab.statuses);

  return (
    <Page>
      <PageTitle title="Payments" subtitle="Simulated EFT, cheque and virtual card. No real money moves." />

      {data.about_to_pay_twice.map((f) => (
        <Notice key={f.payment_ids.join()} tone="negative" title={`About to pay ${f.vendor_name} #${f.invoice_number} twice`}>
          {f.message} Stop one before it goes out:{" "}
          {f.invoice_ids.map((id) => <Link key={id} className="text-button" to={`/invoices/${id}`} style={{ marginRight: 8 }}>{id}</Link>)}
        </Notice>
      ))}

      <div className="section" style={{ marginTop: 28, overflowX: "auto" }}>
        <Segmented size="large" value={tab.key} onChange={(key) => setParams({ tab: String(key) })}
          options={TABS.map((t) => ({ value: t.key, label: `${t.label} · ${count(t)}` }))} />
      </div>

      <div className="section" style={{ marginTop: 28 }}>
        <Hero label={tab.hero} value={money(hero.total)}
          caption={`${hero.count} ${plural(hero.count, isInvoices ? "invoice" : "payment", isInvoices ? "invoices" : "payments")}` +
            (tab.key === "going" && data.summary.scheduled?.next_date ? ` · next on ${shortDate(data.summary.scheduled.next_date, today)}` : "")} />
      </div>

      <Section title={tab.label} caption={isInvoices ? "Open one and press Pay: the payment is prepared and waits for release." : undefined}>
        {isInvoices ? (
          toPay.length === 0 ? <Empty title="Nothing waiting to be paid" /> : (
            <div className="list">
              {toPay.map((i) => (
                <Row key={i.invoice_id} to={`/invoices/${i.invoice_id}`} avatar={<Avatar name={i.vendor_name} />}
                  title={i.vendor_name ?? "—"} sub={`Invoice ${i.vendor_invoice_number} · ${shortDate(i.invoice_date, today)}`}
                  end={<span className="row-amount">{money(i.total_cents, i.currency)}</span>} />
              ))}
            </div>
          )
        ) : data.payments.length === 0 ? <Empty title="Nothing here" /> : (
          <div className="list">{data.payments.map((p) => <PaymentRow key={p.payment_id} p={p} today={today} />)}</div>
        )}
        {isInvoices && credits.length > 0 && (
          <Notice tone="info" title={`${credits.length} approved ${plural(credits.length, "credit note", "credit notes")} waiting`}>
            They'll be deducted automatically from the next payment to {credits.map((c) => c.vendor_name).join(", ")}.
          </Notice>
        )}
      </Section>
    </Page>
  );
}
