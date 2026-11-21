import { CheckCircleFilled, RightOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Findings, HomeData, User } from "../api";
import PaidChart, { cumulative, inRange, type Point, type Range } from "../components/PaidChart";
import PaymentRow from "../components/PaymentRow";
import { Hero, Loading, Page, Panel, Section } from "../components/ui";
import { firstName, longDate, money, monthName, plural } from "../format";
import { useApi, useSession } from "../session";

type Task = { count: number; label: string; to: string };

// What each role is responsible for, so Home only shows a person their own work.
function tasksFor(user: User | null, t: HomeData["todo"]): Task[] {
  if (!user) return [];
  const all: Record<string, Task> = {
    emails: { count: t.emails_to_sort, label: plural(t.emails_to_sort, "Email to sort", "Emails to sort"), to: "/inbox" },
    review: { count: t.needs_review, label: plural(t.needs_review, "Invoice to review", "Invoices to review"), to: "/inbox?tab=review" },
    hold: { count: t.on_hold, label: plural(t.on_hold, "Invoice on hold", "Invoices on hold"), to: "/inbox?tab=hold" },
    approve: { count: t.waiting_for_me, label: plural(t.waiting_for_me, "Invoice to approve", "Invoices to approve"), to: "/approvals" },
    release: { count: t.payments_to_release, label: plural(t.payments_to_release, "Payment to release", "Payments to release"), to: "/payments?tab=prepared" },
    pay: { count: t.approved_to_pay, label: plural(t.approved_to_pay, "Approved invoice to pay", "Approved invoices to pay"), to: "/payments?tab=approved" },
    held: { count: t.payments_held, label: plural(t.payments_held, "Payment held", "Payments held"), to: "/payments?tab=held" },
  };
  const byRole: Record<string, string[]> = {
    ap_clerk: ["emails", "review", "hold", "pay", "held"],
    approver: ["approve"],
    finance_manager: ["approve", "release", "held", "hold"],
    controller_admin: ["approve", "release", "held", "hold"],
  };
  return (byRole[user.role] ?? []).map((k) => all[k]).filter((task) => task.count > 0);
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const RANGE_WORDS: Record<Range, string> = { "1M": "in the last month", "3M": "in the last 3 months", YTD: "this year" };

export default function Home() {
  const { user, today } = useSession();
  const { data, error } = useApi<HomeData>("/home");
  const findings = useApi<Findings>("/findings");
  const [range, setRange] = useState<Range>("YTD");
  const [hover, setHover] = useState<Point | null>(null);
  const series = useMemo(() => (data ? cumulative(data.paid_daily, data.today) : []), [data]);
  const shown = useMemo(() => (data ? inRange(series, range, data.today) : []), [series, range, data]);
  if (!data) return <Loading error={error} />;

  const tasks = tasksFor(user, data.todo);
  const total = series.at(-1)?.cents ?? 0;
  const change = (shown.at(-1)?.cents ?? 0) - (shown[0]?.cents ?? 0);
  const thisMonth = data.paid_by_month.at(-1);

  const rail = (
    <>
      {user && (
        <Panel title="For you">
          {tasks.length ? (
            <div className="list">
              {tasks.map((t) => (
                <Link key={t.label} to={t.to} className="row">
                  <div className="row-main"><div className="row-title">{t.label}</div></div>
                  <span className="nav-count">{t.count}</span>
                  <RightOutlined style={{ fontSize: 11, color: "var(--ink-3)" }} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="muted"><CheckCircleFilled style={{ color: "var(--green)", marginRight: 8 }} />
              {user.role === "auditor" ? "Read-only access." : "You're all caught up."}</div>
          )}
        </Panel>
      )}
      {findings.data && findings.data.overpaid_cad_cents > 0 && (
        <Link to="/activity" className="panel" style={{ display: "block" }}>
          <div className="hero-label">Paid twice this year</div>
          <div style={{ fontSize: 28, fontWeight: 650, letterSpacing: "-0.03em" }} className="num">
            {money(findings.data.overpaid_cad_cents)}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {findings.data.double_payments.filter((f) => f.kind !== "about_to_pay_twice").length} double payments to recover <RightOutlined style={{ fontSize: 10 }} />
          </div>
        </Link>
      )}
      <Panel title={thisMonth ? `${monthName(thisMonth.month, true)} so far` : "This month"}>
        <div className="panel-stat"><span>Paid out</span><span>{money(thisMonth?.total_cad_cents ?? 0)}</span></div>
        <div className="panel-stat"><span>Scheduled to go out</span><span>{money(data.scheduled.total_cad_cents)}</span></div>
        <div className="panel-stat"><span>Invoices on hold</span><span>{data.todo.on_hold}</span></div>
      </Panel>
    </>
  );

  return (
    <Page rail={rail}>
      <p className="muted" style={{ margin: "0 0 18px", fontWeight: 500 }}>
        {user ? `${greeting()}, ${firstName(user.full_name)}` : "Choose who you are to see your work"}
      </p>
      <Hero
        label="Paid to vendors this year"
        value={money(hover ? hover.cents : total)}
        meta={hover
          ? <span>As of {longDate(hover.date)}</span>
          : range === "YTD"
            ? <span>{data.payments_this_year} payments · <b style={{ color: "var(--ink)" }}>{money(thisMonth?.total_cad_cents ?? 0)}</b> so far this month</span>
            : <span><b style={{ color: "var(--ink)" }}>{money(change)}</b> {RANGE_WORDS[range]}</span>}
      />
      <PaidChart points={shown} range={range} onRange={setRange} onPoint={setHover} />

      <Section title="Going out next" extra={<Link to="/payments?tab=going">See all</Link>}>
        <div className="list">
          {data.upcoming.map((p) => <PaymentRow key={p.payment_id} p={p} today={today} />)}
        </div>
      </Section>
    </Page>
  );
}
