import { CheckCircleFilled, RightOutlined } from "@ant-design/icons";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Findings, HomeData, User } from "../api";
import PaidChart, { inRange, type Point, type Range } from "../components/PaidChart";
import PaymentRow from "../components/PaymentRow";
import { Hero, Loading, Money, Page, Panel, Section, Stat } from "../components/ui";
import { firstName, longDate, monthName, plural } from "../format";
import { t } from "../i18n";
import { useApi, useSession } from "../session";

type Task = { count: number; label: string; to: string };

// What each role is responsible for, so Home only shows a person their own work.
function tasksFor(user: User | null, todo: HomeData["todo"]): Task[] {
  if (!user) return [];
  const all: Record<string, Task> = {
    emails: { count: todo.emails_to_sort, label: plural(todo.emails_to_sort, t("Email to sort"), t("Emails to sort")), to: "/inbox" },
    replies: { count: todo.replies_to_send, label: plural(todo.replies_to_send, t("Reply to send"), t("Replies to send")), to: "/inbox?tab=answer" },
    review: { count: todo.needs_review, label: plural(todo.needs_review, t("Invoice to review"), t("Invoices to review")), to: "/inbox?tab=review" },
    hold: { count: todo.on_hold, label: plural(todo.on_hold, t("Invoice on hold"), t("Invoices on hold")), to: "/inbox?tab=hold" },
    approve: { count: todo.waiting_for_me, label: plural(todo.waiting_for_me, t("Invoice to approve"), t("Invoices to approve")), to: "/approvals" },
    release: { count: todo.payments_to_release, label: plural(todo.payments_to_release, t("Payment to release"), t("Payments to release")), to: "/payments?tab=prepared" },
    pay: { count: todo.approved_to_pay, label: plural(todo.approved_to_pay, t("Approved invoice to pay"), t("Approved invoices to pay")), to: "/payments?tab=approved" },
    held: { count: todo.payments_held, label: plural(todo.payments_held, t("Payment held"), t("Payments held")), to: "/payments?tab=held" },
    bank: { count: todo.bank_to_explain, label: plural(todo.bank_to_explain, t("Bank debit to explain"), t("Bank debits to explain")), to: "/bank" },
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
  return t(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
}

const RANGE_WORDS: Record<Range, string> = { "1M": "in the last month", "3M": "in the last 3 months", YTD: "this year" };   // via t()

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
        <Panel title={t("For you")}>
          {tasks.length ? (
            <div className="list">
              {tasks.map((task) => <LinkRow key={task.label} to={task.to} title={task.label} end={<span className="nav-count">{task.count}</span>} />)}
            </div>
          ) : (
            <div className="muted"><CheckCircleFilled className="text-positive" aria-hidden />{" "}
              {t(user.role === "auditor" ? "Read-only access." : "You're all caught up.")}</div>
          )}
        </Panel>
      )}
      {f && (f.overpaid_cad_cents > 0 || f.tax_at_risk_cents > 0 || data.bank_in_question_cents > 0) && (
        <Panel title={t("Money to get back")}>
          <div className="list">
            <LinkRow to="/activity?tab=paid_twice" title={t("Paid twice")}
              sub={f.to_recover_count ? t("{n} still to recover", { n: f.to_recover_count }) : t("All recovered")}
              end={<span className="row-amount"><Money cents={f.to_recover_cad_cents} breakdown={f.to_recover_breakdown} inLink /></span>} />
            {f.tax_at_risk_cents > 0 && (
              <LinkRow to="/activity?tab=tax" title={t("Tax we can't claim back")}
                sub={t(plural(f.tax_invoice_count, "{n} invoice to fix", "{n} invoices to fix"), { n: f.tax_invoice_count })}
                end={<span className="row-amount"><Money cents={f.tax_at_risk_cents} breakdown={f.tax_at_risk_breakdown} inLink /></span>} />
            )}
            {data.bank_in_question_cents > 0 && (
              <LinkRow to="/bank" title={t("Bank debits to explain")}
                sub={t(data.bank_waiting ? "Waiting for the bank's answer" : "Ask the bank")}
                end={<span className="row-amount"><Money cents={data.bank_in_question_cents} breakdown={data.bank_in_question_breakdown} inLink /></span>} />
            )}
          </div>
        </Panel>
      )}
      <Panel title={thisMonth ? t("{month} so far", { month: monthName(thisMonth.month, true) }) : t("This month")}>
        <Stat label={t("Paid out")} value={<Money cents={thisMonth?.total_cad_cents ?? 0} />} />
        <Stat label={t("Scheduled to go out")} value={<Money cents={data.scheduled.total_cad_cents} />} />
        <Stat label={t("Invoices on hold")} value={data.todo.on_hold} />
      </Panel>
    </>
  );

  return (
    <Page rail={rail}>
      <p className="muted strong mb-3 m-0">
        {user ? `${greeting()}, ${firstName(user.full_name)}` : t("Choose who you are to see your work")}
      </p>
      <Hero
        label={t("Paid to vendors this year")}
        cents={hover ? hover.cents : data.paid_this_year_cad_cents}
        countUp={!hover}
        breakdown={hover ? null : data.paid_this_year_breakdown}
        meta={hover
          ? <span>{t("As of {date}", { date: longDate(hover.date) })}</span>
          : range === "YTD"
            ? <span>{t("{n} payments", { n: data.payments_this_year })} · <span className="ink strong"><Money cents={thisMonth?.total_cad_cents ?? 0} /></span> {t("so far this month")}</span>
            : <span><span className="ink strong"><Money cents={data.paid_change[range]} /></span> {t(RANGE_WORDS[range])}</span>}
      />
      <PaidChart points={shown} range={range} onRange={setRange} onPoint={setHover} />

      <Section title={t("Going out next")} extra={<Link to="/payments?tab=going">{t("See all")}</Link>}>
        <div className="list">
          {data.upcoming.map((p) => <PaymentRow key={p.payment_id} p={p} today={today} />)}
        </div>
      </Section>
    </Page>
  );
}
