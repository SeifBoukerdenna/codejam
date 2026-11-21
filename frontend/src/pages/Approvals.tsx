import { CheckCircleFilled } from "@ant-design/icons";
import type { MyApproval } from "../api";
import { Avatar, Empty, Hero, Loading, Page, PageTitle, Panel, Row, Section, Stat } from "../components/ui";
import { APPROVER_ROLE, money, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

// Only the step that is waiting for THIS person now. Routing (delegation, escalation) happened on the server.
export default function Approvals() {
  const { user, today } = useSession();
  const { data, error } = useApi<MyApproval[]>("/approvals/mine");

  if (!user) {
    return <Page><PageTitle title="Approvals" /><Empty title="Who are you?">Choose a user to see what's waiting for them.</Empty></Page>;
  }
  if (!data) return <Loading error={error} />;
  const total = data.reduce((sum, a) => sum + a.total_cad_cents, 0);

  const rail = (
    <Panel title="How approval works">
      <Stat label="Up to $10,000" value="Manager" />
      <Stat label="Over $10,000" value="+ Finance" />
      <Stat label="Over $50,000" value="+ Controller" />
      <Stat label="Over $250,000" value="+ CFO" />
      <p className="small muted" style={{ margin: "12px 0 0" }}>Nobody approves their own request, or two steps of the same invoice.</p>
    </Panel>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="Approvals" />
      {data.length === 0 ? (
        <Empty title="You're all caught up" icon={<CheckCircleFilled style={{ color: "var(--green)" }} />}>Nothing is waiting for you.</Empty>
      ) : (
        <>
          <div style={{ marginTop: 26 }}>
            <Hero label="Waiting for your approval" value={money(total)}
              meta={<span>{data.length} {plural(data.length, "invoice", "invoices")}</span>} />
          </div>
          <Section title="Waiting for you">
            <div className="list">
              {data.map((a) => (
                <Row key={a.approval_id} to={`/invoices/${a.invoice_id}`} avatar={<Avatar name={a.vendor_name} />}
                  title={a.vendor_name ?? "Unknown vendor"}
                  sub={[`#${a.vendor_invoice_number ?? a.invoice_id}`, shortDate(a.invoice_date, today),
                    APPROVER_ROLE[a.approver_role] ?? a.approver_role, a.on_behalf_of_name && `for ${a.on_behalf_of_name}`]
                    .filter(Boolean).join(" · ")}
                  end={<span className="row-amount">{money(a.total_cad_cents)}</span>} />
              ))}
            </div>
          </Section>
        </>
      )}
    </Page>
  );
}
