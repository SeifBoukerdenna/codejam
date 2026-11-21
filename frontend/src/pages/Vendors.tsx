import { SearchOutlined } from "@ant-design/icons";
import { Button, Input, Segmented } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { VendorRow } from "../api";
import { Avatar, Empty, Loading, Page, PageTitle, Pill, Row, Section } from "../components/ui";
import { VENDOR_STATUS, money, statusOf } from "../format";
import VendorForm from "../components/VendorForm";
import { useApi, useSession } from "../session";

function needsAttention(v: VendorRow): boolean {
  return v.status !== "active" || v.bank_change_unverified;
}

export default function Vendors() {
  const { data, error, reload } = useApi<VendorRow[]>("/vendors");
  const { user } = useSession();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "attention">("all");
  if (!data) return <Loading error={error} />;

  const attention = data.filter(needsAttention);
  const q = query.trim().toLowerCase();
  const shown = (filter === "attention" ? attention : data).filter(
    (v) => !q || v.legal_name.toLowerCase().includes(q) || v.category.toLowerCase().includes(q),
  );

  return (
    <Page>
      <PageTitle title="Vendors" subtitle={`${data.length} vendors · ${attention.length} need attention`} />
      {user && ["ap_clerk", "finance_manager", "controller_admin"].includes(user.role) && (
        <div className="section" style={{ marginTop: 24 }}>
          <Button type="primary" shape="round" size="large" onClick={() => setAdding(true)}>Add a vendor</Button>
        </div>
      )}
      <VendorForm open={adding} onClose={() => setAdding(false)}
        onCreated={(id) => { setAdding(false); reload(); navigate(`/vendors/${id}`); }} />
      <div className="section" style={{ marginTop: 28, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search vendors"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 220, borderRadius: 999 }}
        />
        <Segmented
          size="large"
          value={filter}
          onChange={(v) => setFilter(v as "all" | "attention")}
          options={[{ value: "all", label: "All" }, { value: "attention", label: `Needs attention · ${attention.length}` }]}
        />
      </div>
      <Section title={filter === "attention" ? "Needs attention" : "All vendors"} caption="Amounts are what we paid each vendor this year.">
        {shown.length === 0 ? (
          <Empty title="No vendor matches">Try another name.</Empty>
        ) : (
          <div className="list">
            {shown.map((v) => {
              const status = statusOf(VENDOR_STATUS, v.status);
              return (
                <Row
                  key={v.vendor_id}
                  to={`/vendors/${v.vendor_id}`}
                  avatar={<Avatar name={v.legal_name} />}
                  title={v.legal_name}
                  sub={`${v.category} · ${v.province_or_state ?? v.country}`}
                  end={
                    <>
                      <span className="row-amount">{money(v.paid_this_year_cad_cents)}</span>
                      {v.status !== "active" && <Pill tone={status.tone}>{status.label}</Pill>}
                      {v.bank_change_unverified && <Pill tone="negative">Bank change not verified</Pill>}
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </Section>
    </Page>
  );
}
