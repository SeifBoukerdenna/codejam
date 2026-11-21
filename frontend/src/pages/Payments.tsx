import { useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import type { InvoiceRow, PaymentRow, PaymentsPage } from "../api";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { Avatar, Chips, EmptyState, Hero, Loading, Money, Notice, Page, PageTitle, Panel, Stat, StatusPill } from "../components/ui";
import { METHOD, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

type Tab = "approved" | "prepared" | "held" | "going" | "outstanding" | "settled";

// Tabs follow the money: approved → prepared (to release) → going out → paid. Held sits beside them.
const TABS: { key: Tab; label: string; hero: string; statuses: string[] }[] = [
  { key: "approved", label: "Ready to pay", hero: "Approved, not paid yet", statuses: [] },
  { key: "prepared", label: "To release", hero: "Waiting to be released", statuses: ["prepared"] },
  { key: "held", label: "On hold", hero: "On hold", statuses: ["held"] },
  { key: "going", label: "Going out", hero: "Going out", statuses: ["released", "scheduled"] },
  { key: "outstanding", label: "Uncashed cheques", hero: "Cheques not cashed yet", statuses: ["outstanding"] },
  { key: "settled", label: "Paid", hero: "Paid", statuses: ["settled"] },
];

const DEFAULT_ORDER: Tab[] = ["prepared", "approved", "held", "going", "outstanding", "settled"];

export default function Payments() {
  const { today } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get("tab")) ?? TABS[1];
  const isInvoices = tab.key === "approved";
  const page = useApi<PaymentsPage>(`/payments?status=${(isInvoices ? ["prepared"] : tab.statuses).join(",")}`);
  const approved = useApi<InvoiceRow[]>("/invoices?status=approved");
  const data = page.data;

  // Opened without a tab: land on the first one in the money's order that has something in it, not an empty one.
  useEffect(() => {
    if (params.get("tab") || !data) return;
    const first = DEFAULT_ORDER.find((k) => data.tabs[k].count > 0);
    if (first && first !== tab.key) setParams({ tab: first }, { replace: true });
  }, [data, params, tab.key, setParams]);

  if (!data || !approved.data) return <Loading error={page.error ?? approved.error} />;

  const toPay = approved.data.filter((i) => !i.is_credit_note);
  const credits = approved.data.filter((i) => i.is_credit_note);
  const hero = data.tabs[tab.key];

  const paymentColumns: Column<PaymentRow>[] = [
    { key: "vendor", title: "Vendor", render: (p) => (
      <CellWho avatar={<Avatar name={p.vendor_name} size="sm" />} main={p.vendor_name}
        sub={p.hold_reason ?? `Invoice ${p.vendor_invoice_number ?? p.invoice_id}`} />) },
    { key: "method", title: "Method", optional: "wide", width: "method", render: (p) => METHOD[p.method] ?? p.method },
    { key: "date", title: tab.key === "settled" || tab.key === "outstanding" ? "Paid" : "Date", optional: "wide", width: "date",
      render: (p) => shortDate(p.paid_date ?? p.scheduled_date, today) },
    { key: "status", title: "Status", optional: true, width: "status", render: (p) => <StatusPill kind="payment" status={p.status} /> },
    { key: "amount", title: "Amount", align: "right", width: "amount", render: (p) => <Money cents={p.amount_cents} currency={p.currency} /> },
  ];
  const invoiceColumns: Column<InvoiceRow>[] = [
    { key: "vendor", title: "Vendor", render: (i) => (
      <CellWho avatar={<Avatar name={i.vendor_name} size="sm" />} main={i.vendor_name ?? "Unknown vendor"}
        sub={`Invoice ${i.vendor_invoice_number ?? i.invoice_id}`} />) },
    { key: "date", title: "Invoice date", optional: "wide", width: "date", render: (i) => shortDate(i.invoice_date, today) },
    { key: "status", title: "Status", optional: true, width: "status", render: (i) => <StatusPill kind="invoice" status={i.status} /> },
    { key: "amount", title: "Amount", align: "right", width: "amount", render: (i) => <Money cents={i.total_cents} currency={i.currency} /> },
  ];

  const rail = (
    <>
      {data.about_to_pay_twice.map((f) => (
        <Notice key={f.payment_ids.join()} tone="negative" title={`About to pay ${f.vendor_name} twice`}>
          #{f.invoice_number}: {f.payment_ids.join(" and ")} are both scheduled. Stop one:{" "}
          {f.invoice_ids.map((id) => <Link key={id} to={`/invoices/${id}`} className="strong">{id} </Link>)}
        </Notice>
      ))}
      <Panel title="Money going out">
        <Stat label="Waiting to be released" value={<Money cents={data.tabs.prepared.total_cad_cents} />} />
        <Stat label="Released or scheduled" value={<Money cents={data.tabs.going.total_cad_cents} />} />
        <Stat label="On hold" value={<Money cents={data.tabs.held.total_cad_cents} />} />
        <Stat label="Total going out" value={<Money cents={data.going_out.total_cad_cents} />} />
      </Panel>
      {credits.length > 0 && (
        <Panel title="Credits waiting">
          <div className="small muted">Deducted automatically from the next payment to {credits.map((c) => c.vendor_name).join(", ")}.</div>
        </Panel>
      )}
      <p className="small muted m-0">Simulated EFT, cheque and virtual card. No real money moves.</p>
    </>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="Payments" />
      <div className="mt-5">
        <Chips<Tab> label="Payment status" value={tab.key} onChange={(key) => setParams({ tab: key })}
          options={TABS.map((t) => ({ value: t.key, label: t.label, count: data.tabs[t.key].count }))} />
      </div>
      <div className="mt-5">
        <Hero label={tab.hero} cents={hero.total_cad_cents}
          meta={<span>{hero.count} {plural(hero.count, isInvoices ? "invoice" : "payment", isInvoices ? "invoices" : "payments")}
            {tab.key === "going" && data.summary.scheduled?.next_date ? ` · next ${shortDate(data.summary.scheduled.next_date, today)}` : ""}</span>} />
      </div>
      {data.about_to_pay_twice.length > 0 && tab.key === "going" && (
        <Notice tone="negative" title="One invoice is scheduled twice">See the panel on the right before anything goes out.</Notice>
      )}
      <div className="mt-5">
        {isInvoices ? (
          <DataTable label="Approved invoices to pay" columns={invoiceColumns} rows={toPay} rowKey={(i) => i.invoice_id}
            to={(i) => `/invoices/${i.invoice_id}`} empty={<EmptyState title="Nothing waiting to be paid" />} />
        ) : (
          <DataTable label={`${tab.label} payments`} columns={paymentColumns} rows={data.payments} rowKey={(p) => p.payment_id}
            to={(p) => `/invoices/${p.invoice_id}`} empty={<EmptyState title="Nothing here" />} />
        )}
      </div>
    </Page>
  );
}
