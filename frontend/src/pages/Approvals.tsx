import type { MyApproval } from "../api";
import { Avatar, Empty, Loading, Page, PageTitle, Row, Section } from "../components/ui";
import { APPROVER_ROLE, money, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

// The current user's approval queue. Routing (who gets which step, delegation, escalation) is decided
// on the server in step 3; this page only lists what landed on you.
export default function Approvals() {
  const { user, today } = useSession();
  const { data, error } = useApi<MyApproval[]>("/approvals/mine");

  if (!user) {
    return (
      <Page>
        <PageTitle title="Approvals" />
        <Empty title="Who are you?">Choose a user in the top right to see the invoices waiting for them.</Empty>
      </Page>
    );
  }
  if (!data) return <Loading error={error} />;

  return (
    <Page>
      <PageTitle
        title="Approvals"
        subtitle={data.length ? `${data.length} ${plural(data.length, "invoice is", "invoices are")} waiting for you` : undefined}
      />
      {data.length === 0 ? (
        <Empty title="Nothing waiting for you">Invoices that need your approval will show up here.</Empty>
      ) : (
        <Section title="Waiting for you">
          <div className="list">
            {data.map((a) => (
              <Row
                key={a.approval_id}
                to={`/invoices/${a.invoice_id}`}
                avatar={<Avatar name={a.vendor_name} />}
                title={a.vendor_name ?? "Unknown vendor"}
                sub={[
                  `Invoice ${a.vendor_invoice_number ?? a.invoice_id}`,
                  shortDate(a.invoice_date, today),
                  APPROVER_ROLE[a.approver_role] ?? a.approver_role,
                  a.on_behalf_of_name && `for ${a.on_behalf_of_name}`,
                ].filter(Boolean).join(" · ")}
                end={<span className="row-amount">{money(a.total_cad_cents)}</span>}
              />
            ))}
          </div>
        </Section>
      )}
    </Page>
  );
}
