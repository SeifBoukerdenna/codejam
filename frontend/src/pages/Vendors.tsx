import { SearchOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { VendorRow } from "../api";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { Avatar, Chips, EmptyState, Loading, Money, Page, PageTitle, Panel, Pill, Row } from "../components/ui";
import VendorForm from "../components/VendorForm";
import { VENDOR_STATUS, money, statusOf } from "../format";
import { useApi, useSession } from "../session";

function needsAttention(v: VendorRow): boolean {
  return v.status !== "active" || v.bank_change_unverified;
}

type Filter = "all" | "attention";

export default function Vendors() {
  const { data, error, reload } = useApi<VendorRow[]>("/vendors");
  const { user } = useSession();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  if (!data) return <Loading error={error} />;

  const attention = data.filter(needsAttention);
  const q = query.trim().toLowerCase();
  const shown = (filter === "attention" ? attention : data)
    .filter((v) => !q || v.legal_name.toLowerCase().includes(q) || v.category.toLowerCase().includes(q));
  const top = [...data].sort((a, b) => b.paid_this_year_cad_cents - a.paid_this_year_cad_cents).slice(0, 5);
  const canAdd = user && ["ap_clerk", "finance_manager", "controller_admin"].includes(user.role);

  const columns: Column<VendorRow>[] = [
    { key: "vendor", title: "Vendor", render: (v) => (
      <CellWho avatar={<Avatar name={v.legal_name} size="sm" />} main={v.legal_name} sub={v.category} />) },
    { key: "where", title: "Province", optional: "wide", width: "num", render: (v) => v.province_or_state ?? v.country },
    { key: "status", title: "Status", width: "status", render: (v) => v.bank_change_unverified
      ? <Pill tone="negative">Bank change not verified</Pill>
      : <Pill tone={statusOf(VENDOR_STATUS, v.status).tone}>{statusOf(VENDOR_STATUS, v.status).label}</Pill> },
    { key: "invoices", title: "Invoices", align: "right", optional: "wide", width: "num", render: (v) => v.invoice_count },
    { key: "paid", title: "Paid this year", align: "right", optional: true, width: "amount", render: (v) => <Money cents={v.paid_this_year_cad_cents} /> },
  ];

  const rail = (
    <>
      {attention.length > 0 && (
        <Panel title="Needs attention">
          <div className="list">
            {attention.map((v) => (
              <Row key={v.vendor_id} to={`/vendors/${v.vendor_id}`} avatar={<Avatar name={v.legal_name} size="sm" />}
                title={v.legal_name} sub={v.bank_change_unverified ? "Bank change not verified" : statusOf(VENDOR_STATUS, v.status).label} />
            ))}
          </div>
        </Panel>
      )}
      <Panel title="Most paid this year">
        <div className="list">
          {top.map((v) => (
            <Row key={v.vendor_id} to={`/vendors/${v.vendor_id}`} avatar={<Avatar name={v.legal_name} size="sm" />}
              title={v.legal_name} end={<span className="row-amount small">{money(v.paid_this_year_cad_cents, "CAD", true)}</span>} />
          ))}
        </div>
      </Panel>
    </>
  );

  return (
    <Page rail={rail}>
      <div className="spread">
        <PageTitle title="Vendors" />
        {canAdd && <Button type="primary" shape="round" size="large" onClick={() => setAdding(true)}>Add a vendor</Button>}
      </div>
      <VendorForm open={adding} onClose={() => setAdding(false)}
        onCreated={(id) => { setAdding(false); reload(); navigate(`/vendors/${id}`); }} />

      <Input size="large" allowClear prefix={<SearchOutlined className="ink-3" />} placeholder="Search vendors" aria-label="Search vendors"
        value={query} onChange={(e) => setQuery(e.target.value)} className="search-input mt-5" />
      <div className="mt-4">
        <Chips<Filter> label="Vendor filter" value={filter} onChange={setFilter} options={[
          { value: "all", label: "All", count: data.length }, { value: "attention", label: "Needs attention", count: attention.length }]} />
      </div>

      <div className="mt-5">
        <DataTable label="Vendors" columns={columns} rows={shown} rowKey={(v) => v.vendor_id} to={(v) => `/vendors/${v.vendor_id}`}
          empty={<EmptyState title="No vendor matches" />} />
      </div>
    </Page>
  );
}
