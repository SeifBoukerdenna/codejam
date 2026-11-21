import { Segmented } from "antd";
import { useSearchParams } from "react-router";
import type { PaymentRow as Payment } from "../api";
import PaymentRow from "../components/PaymentRow";
import { Empty, Hero, Loading, Page, PageTitle, Section } from "../components/ui";
import { money, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

type Summary = Record<string, { count: number; total_cad_cents: number; next_date: string | null }>;

const TABS = [
  { key: "scheduled", label: "Scheduled", hero: "Scheduled to go out" },
  { key: "outstanding", label: "Cheques not cashed", hero: "Sent by cheque, not cashed yet" },
  { key: "settled", label: "Paid", hero: "Paid" },
];

export default function Payments() {
  const { today } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get("tab")) ?? TABS[0];
  const { data, error } = useApi<{ payments: Payment[]; summary: Summary }>(`/payments?status=${tab.key}`);
  if (!data) return <Loading error={error} />;

  const s = data.summary[tab.key] ?? { count: 0, total_cad_cents: 0, next_date: null };

  return (
    <Page>
      <PageTitle title="Payments" />
      <div className="section" style={{ marginTop: 28 }}>
        <Segmented
          size="large"
          value={tab.key}
          onChange={(key) => setParams({ tab: String(key) })}
          options={TABS.map((t) => ({
            value: t.key,
            label: `${t.label} · ${data.summary[t.key]?.count ?? 0}`,
          }))}
        />
      </div>
      <div className="section" style={{ marginTop: 28 }}>
        <Hero
          label={tab.hero}
          value={money(s.total_cad_cents)}
          caption={`${s.count} ${plural(s.count, "payment", "payments")}` +
            (tab.key === "scheduled" && s.next_date ? ` · next on ${shortDate(s.next_date, today)}` : "")}
        />
      </div>
      <Section title={tab.label}>
        {data.payments.length === 0 ? (
          <Empty title="Nothing here">No payments in this list.</Empty>
        ) : (
          <div className="list">
            {data.payments.map((p) => <PaymentRow key={p.payment_id} p={p} today={today} />)}
          </div>
        )}
      </Section>
    </Page>
  );
}
