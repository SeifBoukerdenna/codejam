import { SearchOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { VendorRow } from "../api";
import { Avatar, Chips, Empty, Loading, Page, PageTitle, Panel, Pill, Row, Section } from "../components/ui";
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <PageTitle title="Vendors" />
        {canAdd && <Button type="primary" shape="round" size="large" onClick={() => setAdding(true)}>Add a vendor</Button>}
      </div>
      <VendorForm open={adding} onClose={() => setAdding(false)}
        onCreated={(id) => { setAdding(false); reload(); navigate(`/vendors/${id}`); }} />

      <Input size="large" allowClear prefix={<SearchOutlined style={{ color: "var(--ink-3)" }} />} placeholder="Search vendors"
        value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginTop: 22, borderRadius: 999, height: 50 }} />
      <div style={{ marginTop: 14 }}>
        <Chips<Filter> value={filter} onChange={setFilter} options={[
          { value: "all", label: "All", count: data.length }, { value: "attention", label: "Needs attention", count: attention.length }]} />
      </div>

      <Section title={filter === "attention" ? "Needs attention" : "All vendors"} extra={<span>Paid this year</span>}>
        {shown.length === 0 ? <Empty title="No vendor matches" /> : (
          <div className="list">
            {shown.map((v) => {
              const s = statusOf(VENDOR_STATUS, v.status);
              return (
                <Row key={v.vendor_id} to={`/vendors/${v.vendor_id}`} avatar={<Avatar name={v.legal_name} />}
                  title={v.legal_name} sub={`${v.category} · ${v.province_or_state ?? v.country}`}
                  end={<>
                    <span className="row-amount">{money(v.paid_this_year_cad_cents)}</span>
                    {v.bank_change_unverified ? <Pill tone="negative">Bank change</Pill> : v.status !== "active" && <Pill tone={s.tone}>{s.label}</Pill>}
                  </>} />
              );
            })}
          </div>
        )}
      </Section>
    </Page>
  );
}
