import { Select } from "antd";
import { NavLink, Outlet } from "react-router";
import { ROLE } from "../format";
import { useSession } from "../session";
import { Avatar } from "./ui";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/inbox", label: "Inbox" },
  { to: "/approvals", label: "Approvals" },
  { to: "/payments", label: "Payments" },
  { to: "/vendors", label: "Vendors" },
  { to: "/activity", label: "Activity" },
];

export default function AppShell() {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">Harborline</NavLink>
          <nav className="nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>
            ))}
          </nav>
          <UserSwitcher />
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}

// DECISION: demo login is a user picker. Switching user is how separation of duties is shown live
// (e.g. approve as Elise, then try to release the payment as Elise and get refused by the server).
function UserSwitcher() {
  const { users, user, userId, setUserId } = useSession();
  return (
    <div className="user-menu">
      {user && <Avatar name={user.full_name} size="small" dark />}
      <Select
        variant="borderless"
        showSearch={{
          filterOption: (input, option) => (option?.search ?? "").includes(input.toLowerCase()),
        }}
        placeholder="Choose who you are"
        value={userId ?? undefined}
        onChange={setUserId}
        className="user-select"
        popupMatchSelectWidth={340}
        aria-label="Act as user"
        options={users.map((u) => ({
          value: u.user_id,
          label: u.full_name,
          search: `${u.user_id} ${u.full_name} ${u.title} ${u.department}`.toLowerCase(),
          u,
        }))}
        optionRender={(option) => {
          const u = option.data.u;
          return (
            <div>
              <div style={{ fontWeight: 500 }}>
                {u.full_name}
                {u.status !== "active" && <span className="muted"> · {u.status.replace("_", " ")}</span>}
              </div>
              <div className="muted small">{u.title} · {ROLE[u.role] ?? u.role} · {u.user_id}</div>
            </div>
          );
        }}
      />
    </div>
  );
}
