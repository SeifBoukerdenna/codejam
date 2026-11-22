import { CheckCircleFilled, RightOutlined } from "@ant-design/icons";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Findings, HomeData, User } from "../api";
import PaidChart, { inRange, type Point, type Range } from "../components/PaidChart";
import PaymentRow from "../components/PaymentRow";
import { Hero, Loading, Money, Page, Panel, Section, Stat } from "../components/ui";
import { firstName, longDate, monthName, plural } from "../format";
import { useApi, useSession } from "../session";

type Task = { count: number; label: string; to: string };

// What each role is responsible for, so Home only shows a person their own work.
function tasksFor(user: User | null, t: HomeData["todo"]): Task[] {
  if (!user) return [];
  const all: Record<string, Task> = {
    emails: { count: t.emails_to_sort, label: plural(t.emails_to_sort, "Email to sort", "Emails to sort"), to: "/inbox" },
    replies: { count: t.replies_to_send, label: plural(t.replies_to_send, "Reply to send", "Replies to send"), to: "/inbox?tab=answer" },
    review: { count: t.needs_review, label: plural(t.needs_review, "Invoice to review", "Invoices to review"), to: "/inbox?tab=review" },
    hold: { count: t.on_hold, label: plural(t.on_hold, "Invoice on hold", "Invoices on hold"), to: "/inbox?tab=hold" },
    approve: { count: t.waiting_for_me, label: plural(t.waiting_for_me, "Invoice to approve", "Invoices to approve"), to: "/approvals" },
    release: { count: t.payments_to_release, label: plural(t.payments_to_release, "Payment to release", "Payments to release"), to: "/payments?tab=prepared" },
    pay: { count: t.approved_to_pay, label: plural(t.approved_to_pay, "Approved invoice to pay", "Approved invoices to pay"), to: "/payments?tab=approved" },
    held: { count: t.payments_held, label: plural(t.payments_held, "Payment held", "Payments held"), to: "/payments?tab=held" },
    bank: { count: t.bank_to_explain, label: plural(t.bank_to_explain, "Bank debit to explain", "Bank debits to explain"), to: "/bank" },
  };
  const byRole: Record<string, string[]> = {
    ap_clerk: ["emails", "replies", "review", "hold", "pay", "held", "bank"],
    approver: ["approve"],
    finance_manager: ["approve", "release", "held", "hold", "bank"],
    controller_admin: ["approve", "release", "held", "hold", "bank"],
  };
  return (byRole[user.role] ?? []).map((k) => all[k]).filter((task) => task.count > 0);
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const RANGE_WORDS: Record<Range, string> = { "1M": "in the last month", "3M": "in the last 3 months", YTD: "this year" };

/** A row in a side panel that leads somewhere: label, one line of context, an amount or a count. */
function LinkRow({ to, title, sub, end }: { to: string; title: string; sub?: string; end: ReactNode }) {
  return (
    <Link to={to} className="row">
      <div className="row-main">
        <div className="row-title">{title}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      {end}
      <RightOutlined className="chevron" aria-hidden />
    </Link>
  );
}

export default function Home() {
  const { user, today } = useSession();
  const { data, error } = useApi<HomeData>("/home");
  const findings = useApi<Findings>("/findings");
  const [range, setRange] = useState<Range>("YTD");
  const [hover, setHover] = useState<Point | null>(null);
  const shown = useMemo(() => (data ? inRange(data.paid_running, range, data.today) : []), [range, data]);
  if (!data) return <Loading error={error} />;

  const tasks = tasksFor(user, data.todo);
  const thisMonth = data.paid_by_month.at(-1);
  const f = findings.data;

  const rail = (
    <>
      {user && (
        <Panel title="For you">
          {tasks.length ? (
            <div className="list">
              {tasks.map((t) => <LinkRow key={t.label} to={t.to} title={t.label} end={<span className="nav-count">{t.count}</span>} />)}
            </div>
          ) : (
            <div className="muted"><CheckCircleFilled className="text-positive" aria-hidden />{" "}
              {user.role === "auditor" ? "Read-only access." : "You're all caught up."}</div>
          )}
        </Panel>
      )}
      {f && (f.overpaid_cad_cents > 0 || f.tax_at_risk_cents > 0 || data.bank_in_question_cents > 0) && (
        <Panel title="Money to get back">
          <div className="list">
            <LinkRow to="/activity?tab=paid_twice" title="Paid twice"
              sub={f.to_recover_count ? `${f.to_recover_count} still to recover` : "All recovered"}
              end={<span className="row-amount"><Money cents={f.to_recover_cad_cents} breakdown={f.to_recover_breakdown} inLink /></span>} />
            {f.tax_at_risk_cents > 0 && (
              <LinkRow to="/activity?tab=tax" title="Tax we can't claim back"
                sub={`${f.tax_invoice_count} ${plural(f.tax_invoice_count, "invoice", "invoices")} to fix`}
                end={<span className="row-amount"><Money cents={f.tax_at_risk_cents} breakdown={f.tax_at_risk_breakdown} inLink /></span>} />
            )}
            {data.bank_in_question_cents > 0 && (
              <LinkRow to="/bank" title="Bank debits to explain"
                sub={data.bank_waiting ? "Waiting for the bank's answer" : "Ask the bank"}
                end={<span className="row-amount"><Money cents={data.bank_in_question_cents} breakdown={data.bank_in_question_breakdown} inLink /></span>} />
            )}
          </div>
        </Panel>
      )}
      <Panel title={thisMonth ? `${monthName(thisMonth.month, true)} so far` : "This month"}>
        <Stat label="Paid out" value={<Money cents={thisMonth?.total_cad_cents ?? 0} />} />
        <Stat label="Scheduled to go out" value={<Money cents={data.scheduled.total_cad_cents} />} />
        <Stat label="Invoices on hold" value={data.todo.on_hold} />
      </Panel>
    </>
  );

  return (
    <Page rail={rail}>
      <p className="muted strong mb-3 m-0">
        {user ? `${greeting()}, ${firstName(user.full_name)}` : "Choose who you are to see your work"}
      </p>
      <Hero
        label="Paid to vendors this year"
        cents={hover ? hover.cents : data.paid_this_year_cad_cents}
        countUp={!hover}
        breakdown={hover ? null : data.paid_this_year_breakdown}
        meta={hover
          ? <span>As of {longDate(hover.date)}</span>
          : range === "YTD"
            ? <span>{data.payments_this_year} payments · <span className="ink strong"><Money cents={thisMonth?.total_cad_cents ?? 0} /></span> so far this month</span>
            : <span><span className="ink strong"><Money cents={data.paid_change[range]} /></span> {RANGE_WORDS[range]}</span>}
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
