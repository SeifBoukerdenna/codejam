import { CheckCircleFilled } from "@ant-design/icons";
import type { MyApproval, MyApprovals } from "../api";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { Avatar, EmptyState, Hero, Loading, Money, Page, PageTitle, Panel, Stat } from "../components/ui";
import { APPROVER_ROLE, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

// Only the step that is waiting for THIS person now. Routing (delegation, escalation) happened on the server.
export default function Approvals() {
  const { user, today } = useSession();
  const { data, error } = useApi<MyApprovals>("/approvals/mine");

  if (!user) {
    return <Page><PageTitle title="Approvals" /><EmptyState title="Who are you?">Choose a user to see what's waiting for them.</EmptyState></Page>;
  }
  if (!data) return <Loading error={error} />;
  const items = data.items;

  const columns: Column<MyApproval>[] = [
    { key: "vendor", title: "Vendor", render: (a) => (
      <CellWho avatar={<Avatar name={a.vendor_name} size="sm" />} main={a.vendor_name ?? "Unknown vendor"}
        sub={`Invoice ${a.vendor_invoice_number ?? a.invoice_id}`} />) },
    { key: "step", title: "Your step", optional: "wide", width: "status", render: (a) => (
      <span>{APPROVER_ROLE[a.approver_role] ?? a.approver_role}{a.on_behalf_of_name ? ` · for ${a.on_behalf_of_name}` : ""}</span>) },
    { key: "date", title: "Invoice date", optional: "wide", width: "date", render: (a) => shortDate(a.invoice_date, today) },
    { key: "amount", title: "Amount", align: "right", width: "amount", render: (a) => <Money cents={a.total_cad_cents} /> },
  ];

  const rail = (
    <Panel title="How approval works">
      <Stat label="Up to $10,000" value="Manager" />
      <Stat label="Over $10,000" value="+ Finance" />
      <Stat label="Over $50,000" value="+ Controller" />
      <Stat label="Over $250,000" value="+ CFO" />
      <p className="small muted mt-3 m-0">Nobody approves their own request, or two steps of the same invoice.</p>
    </Panel>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="Approvals" />
      {items.length === 0 ? (
        <EmptyState title="You're all caught up" icon={<CheckCircleFilled className="text-positive" />}>Nothing is waiting for you.</EmptyState>
      ) : (
        <>
          <div className="mt-5">
            <Hero label="Waiting for your approval" cents={data.total_cad_cents}
              meta={<span>{items.length} {plural(items.length, "invoice", "invoices")}</span>} />
          </div>
          <div className="mt-5">
            <DataTable label="Invoices waiting for your approval" columns={columns} rows={items}
              rowKey={(a) => a.approval_id} to={(a) => `/invoices/${a.invoice_id}`} />
          </div>
        </>
      )}
    </Page>
  );
}
