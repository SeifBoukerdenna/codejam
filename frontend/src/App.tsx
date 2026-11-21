import { Alert, Card, Layout, Select, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { api, getCurrentUserId, setCurrentUserId, type User } from "./api";

const { Header, Content } = Layout;

// Step 1 screen: proves the stack runs end to end (UI -> API -> seeded Postgres) and gives the demo its
// user switcher. The real pages (inbox, invoice detail, approvals, payments, vendors, audit) come in step 5.
export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string | null>(getCurrentUserId());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [today, setToday] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<User[]>("/users"),
      api<Record<string, number>>("/stats"),
      api<{ today: string }>("/health"),
    ])
      .then(([u, c, h]) => {
        setUsers(u);
        setCounts(c);
        setToday(h.today);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const pickUser = (id: string) => {
    setCurrentUserId(id);
    setUserId(id);
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Typography.Text strong style={{ color: "white", fontSize: 18, flex: 1 }}>
          Harborline AP
        </Typography.Text>
        <Select
          showSearch
          placeholder="Act as user…"
          style={{ width: 380 }}
          value={userId ?? undefined}
          onChange={pickUser}
          optionFilterProp="label"
          options={users.map((u) => ({
            value: u.user_id,
            label: `${u.user_id} · ${u.full_name} — ${u.title}${u.status !== "active" ? ` (${u.status})` : ""}`,
          }))}
        />
      </Header>
      <Content style={{ padding: 24, maxWidth: 900, margin: "0 auto", width: "100%" }}>
        {error && <Alert type="error" message={`API error: ${error}`} style={{ marginBottom: 16 }} />}
        <Card title="Database" extra={today && <Tag>Today: {today}</Tag>}>
          <Table
            size="small"
            pagination={false}
            rowKey="table"
            dataSource={Object.entries(counts).map(([table, rows]) => ({ table, rows }))}
            columns={[
              { title: "Table", dataIndex: "table" },
              { title: "Rows", dataIndex: "rows", align: "right" },
            ]}
          />
        </Card>
      </Content>
    </Layout>
  );
}
