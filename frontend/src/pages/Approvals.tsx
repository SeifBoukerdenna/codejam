import { CheckCircleFilled } from "@ant-design/icons";
import type { MyApproval, MyApprovals } from "../api";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { Avatar, EmptyState, Hero, Loading, Money, Page, PageTitle, Panel, Stat } from "../components/ui";
import { APPROVER_ROLE, plural, shortDate } from "../format";
import { t } from "../i18n";
import { useApi, useSession } from "../session";

// Only the step that is waiting for THIS person now. Routing (delegation, escalation) happened on the server.
export default function Approvals() {
  const { user, today } = useSession();
  const { data, error } = useApi<MyApprovals>("/approvals/mine");

  if (!user) {
    return <Page><PageTitle title={t("Approvals")} /><EmptyState title={t("Who are you?")}>{t("Choose a user to see what's waiting for them.")}</EmptyState></Page>;
  }
  if (!data) return <Loading error={error} />;
  const items = data.items;

  const columns: Column<MyApproval>[] = [
    { key: "vendor", title: t("Vendor"), render: (a) => (
      <CellWho avatar={<Avatar name={a.vendor_name} size="sm" />} main={a.vendor_name ?? t("Unknown vendor")}
        sub={t("Invoice {number}", { number: a.vendor_invoice_number ?? a.invoice_id })} />) },
    { key: "step", title: t("Your step"), optional: "wide", width: "status", render: (a) => (
      <span>{t(APPROVER_ROLE[a.approver_role] ?? a.approver_role)}{a.on_behalf_of_name ? ` · ${t("for {name}", { name: a.on_behalf_of_name })}` : ""}</span>) },
    { key: "date", title: t("Invoice date"), optional: "wide", width: "date", render: (a) => shortDate(a.invoice_date, today) },
    { key: "amount", title: t("Amount"), align: "right", width: "amount", render: (a) => <Money cents={a.total_cad_cents} /> },
  ];

  const rail = (
    <Panel title={t("How approval works")}>
      <Stat label={t("Up to $10,000")} value={t("Manager")} />
      <Stat label={t("Over $10,000")} value={t("+ Finance")} />
      <Stat label={t("Over $50,000")} value={t("+ Controller")} />
      <Stat label={t("Over $250,000")} value={t("+ CFO")} />
      <p className="small muted mt-3 m-0">{t("Nobody approves their own request, or two steps of the same invoice.")}</p>
    </Panel>
  );

  return (
    <Page rail={rail}>
      <PageTitle title={t("Approvals")} />
      {items.length === 0 ? (
        <EmptyState title={t("You're all caught up")} icon={<CheckCircleFilled className="text-positive" />}>{t("Nothing is waiting for you.")}</EmptyState>
      ) : (
        <>
          <div className="mt-5">
            <Hero label={t("Waiting for your approval")} cents={data.total_cad_cents}
              meta={<span>{t(plural(items.length, "{n} invoice", "{n} invoices"), { n: items.length })}</span>} />
          </div>
          <div className="mt-5">
            <DataTable label={t("Invoices waiting for your approval")} columns={columns} rows={items}
              rowKey={(a) => a.approval_id} to={(a) => `/invoices/${a.invoice_id}`} />
          </div>
        </>
      )}
    </Page>
  );
}
