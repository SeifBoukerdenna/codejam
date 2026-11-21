import { Link } from "react-router";
import type { HomeData, User } from "../api";
import MonthlyBars from "../components/MonthlyBars";
import PaymentRow from "../components/PaymentRow";
import { Hero, Loading, Page, PageTitle, Section } from "../components/ui";
import { firstName, longDate, money, plural, type Tone } from "../format";
import { useApi, useSession } from "../session";

type Task = { count: number; label: string; to: string; tone: Tone };

// What each role is responsible for, so Home only shows a person their own work.
function tasksFor(user: User | null, todo: HomeData["todo"]): Task[] {
  if (!user) return [];
  const t = todo;
  const all: Record<string, Task> = {
    emails: { count: t.emails_to_sort, label: plural(t.emails_to_sort, "email to sort", "emails to sort"), to: "/inbox", tone: "neutral" },
    review: { count: t.needs_review, label: plural(t.needs_review, "invoice to review", "invoices to review"), to: "/inbox", tone: "warning" },
    hold: { count: t.on_hold, label: plural(t.on_hold, "invoice on hold", "invoices on hold"), to: "/inbox", tone: "negative" },
    approve: { count: t.waiting_for_me, label: plural(t.waiting_for_me, "invoice to approve", "invoices to approve"), to: "/approvals", tone: "warning" },
    release: { count: t.payments_to_release, label: plural(t.payments_to_release, "payment to release", "payments to release"), to: "/payments?tab=prepared", tone: "warning" },
  };
  const byRole: Record<string, string[]> = {
    ap_clerk: ["emails", "review", "hold"],
    approver: ["approve"],
    finance_manager: ["approve", "release", "hold"],
    controller_admin: ["approve", "release", "hold"],
    employee: [],
    auditor: [],
  };
  return (byRole[user.role] ?? []).map((k) => all[k]).filter((task) => task.count > 0);
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function Home() {
  const { user, today } = useSession();
  const { data, error } = useApi<HomeData>("/home");
  if (!data) return <Loading error={error} />;

  const tasks = tasksFor(user, data.todo);

  return (
    <Page>
      <PageTitle
        title={user ? `${greeting()}, ${firstName(user.full_name)}` : "Welcome to Harborline AP"}
        subtitle={user ? `${user.title} · ${user.department}` : "Choose who you are in the top right to see your work."}
      />

      {user && (
        <Section title="For you">
          {tasks.length > 0 ? (
            <div className="tasks">
              {tasks.map((t) => (
                <Link key={t.label} to={t.to} className={`task ${t.tone}`}>
                  <div className="task-count">{t.count}</div>
                  <div className="task-label">{t.label}</div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">
              {user.role === "auditor" ? "You have read-only access to everything." : "You're all caught up."}
            </p>
          )}
        </Section>
      )}

      <div className="section">
        <Hero
          label="Paid to vendors this year"
          value={money(data.paid_this_year_cad_cents)}
          caption={`${data.payments_this_year} payments · as of ${longDate(data.today)}`}
        />
        <MonthlyBars data={data.paid_by_month} today={data.today} />
      </div>

      <Section
        title="Going out next"
        extra={<Link to="/payments">See all</Link>}
        caption={`${money(data.scheduled.total_cad_cents)} across ${data.scheduled.count} scheduled ${plural(data.scheduled.count, "payment", "payments")}`}
      >
        <div className="list">
          {data.upcoming.map((p) => <PaymentRow key={p.payment_id} p={p} today={today} />)}
        </div>
      </Section>
    </Page>
  );
}
