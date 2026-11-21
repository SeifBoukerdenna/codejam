import { AuditOutlined, CheckCircleOutlined, HomeOutlined, InboxOutlined, ShopOutlined, SwapOutlined } from "@ant-design/icons";
import { Select } from "antd";
import { useEffect, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import type { HomeData } from "../api";
import { ROLE, longDate } from "../format";
import { useApi, useSession } from "../session";
import { Avatar } from "./ui";

type Item = { to: string; label: string; icon: ReactNode; end?: boolean; count?: number };

// Left sidebar on desktop, bottom tab bar on phones. Counts are this user's open work, like an inbox badge.
export default function AppShell() {
  const { user, today } = useSession();
  const { data, reload } = useApi<HomeData>("/home");
  const { pathname } = useLocation();
  // Badges refresh on every page change, so a count drops right after you clear an item.
  useEffect(() => reload(), [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = data?.todo;
  const isFinance = user && ["finance_manager", "controller_admin"].includes(user.role);
  const isClerk = user?.role === "ap_clerk";
  const nav: Item[] = [
    { to: "/", label: "Home", icon: <HomeOutlined />, end: true },
    { to: "/inbox", label: "Inbox", icon: <InboxOutlined />, count: isClerk || isFinance ? (t?.emails_to_sort ?? 0) + (t?.needs_review ?? 0) : 0 },
    { to: "/approvals", label: "Approvals", icon: <CheckCircleOutlined />, count: t?.waiting_for_me ?? 0 },
    { to: "/payments", label: "Payments", icon: <SwapOutlined />,
      count: isFinance ? t?.payments_to_release ?? 0 : isClerk ? t?.approved_to_pay ?? 0 : 0 },
    { to: "/vendors", label: "Vendors", icon: <ShopOutlined /> },
    { to: "/activity", label: "Activity", icon: <AuditOutlined /> },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand"><span className="brand-mark">H</span>Harborline</NavLink>
        <nav className="side-nav">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.icon}<span>{n.label}</span>
              {!!n.count && <span className="nav-count">{n.count}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="side-user">
          {today && <div className="today-chip">Today is {longDate(today)}</div>}
          <UserSwitcher />
        </div>
      </aside>

      <header className="mobile-top">
        <NavLink to="/" className="brand" style={{ padding: 0 }}><span className="brand-mark">H</span>Harborline</NavLink>
        <UserSwitcher compact />
      </header>

      <main className="main"><Outlet /></main>

      <nav className="tabbar">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>{n.icon}<span>{n.label}</span></NavLink>
        ))}
      </nav>
    </div>
  );
}

// DECISION: demo login is a user picker. Switching user is how separation of duties is shown live
// (approve as Elise, then try to release the payment as Elise and get refused by the server).
function UserSwitcher({ compact }: { compact?: boolean }) {
  const { users, userId, setUserId } = useSession();
  return (
    <Select
      className="user-select"
      variant="borderless"
      suffix={null}
      showSearch={{ filterOption: (input, option) => (option?.search ?? "").includes(input.toLowerCase()) }}
      placeholder="Choose who you are"
      value={userId ?? undefined}
      onChange={setUserId}
      style={{ width: compact ? 170 : "100%", height: 52 }}
      popupMatchSelectWidth={320}
      placement={compact ? "bottomRight" : "topLeft"}
      aria-label="Act as user"
      options={users.map((u) => ({
        value: u.user_id, label: u.full_name, u,
        search: `${u.user_id} ${u.full_name} ${u.title} ${u.department}`.toLowerCase(),
      }))}
      labelRender={(selected) => {
        const u = users.find((x) => x.user_id === selected.value);
        if (!u) return <span className="muted">Choose who you are</span>;
        return (
          <span className="user-pill">
            <Avatar name={u.full_name} size="sm" round dark />
            <span style={{ minWidth: 0 }}>
              <span className="user-pill-name" style={{ display: "block" }}>{u.full_name}</span>
              {!compact && <span className="user-pill-role" style={{ display: "block" }}>{ROLE[u.role] ?? u.role}</span>}
            </span>
          </span>
        );
      }}
      optionRender={(option) => {
        const u = option.data.u;
        return (
          <div className="user-pill" style={{ padding: "4px 0" }}>
            <Avatar name={u.full_name} size="sm" round />
            <div style={{ minWidth: 0 }}>
              <div className="user-pill-name">{u.full_name}{u.status !== "active" && <span className="muted"> · {u.status.replace("_", " ")}</span>}</div>
              <div className="user-pill-role">{u.title} · {ROLE[u.role] ?? u.role}</div>
            </div>
          </div>
        );
      }}
    />
  );
}
