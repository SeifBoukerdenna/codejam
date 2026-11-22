import { AppstoreOutlined, ArrowRightOutlined, SafetyCertificateOutlined, SearchOutlined, SwapOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Modal } from "antd";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, send, type ChainCheck, type SearchResults, type User } from "../api";
import { ROLE, VENDOR_STATUS, shortDate, statusOf } from "../format";
import { useSession } from "../session";
import { t } from "../i18n";
import { useRunner } from "./actions";
import { Avatar, Kbd, Money, Pill, StatusPill } from "./ui";

// Cmd+K (Ctrl+K on Windows/Linux) from anywhere: find an invoice by number, vendor or amount, a vendor, a page, run an
// action, or switch who you are ("as Elise", "controller"). In-house: a text box and a list, about 250 lines.
// Searching invoices and vendors is the server's job (app/search.py); people, pages and actions are matched here.

export const OPEN_PALETTE = "harborline:open-palette";
const RECENT_KEY = "harborline:recent";
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const PALETTE_KEYS = isMac ? "⌘ K" : "Ctrl K";

type Recent = { key: string; kind: "invoice" | "vendor"; title: string; sub: string; to: string };

// DECISION: recently opened invoices and vendors live in localStorage, per browser: a convenience, not a record.
// Nothing depends on it, and it's wrapped in try/catch so a private window simply has no "Recent".
function readRecent(): Recent[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}

/** Called by the invoice and vendor pages when they open, so the palette shows them first next time. */
export function rememberVisit(item: Recent) {
  try {
    const rest = readRecent().filter((r) => r.key !== item.key);
    localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...rest].slice(0, 6)));
  } catch { /* no storage: no recent list */ }
}

const PAGES: { title: string; to: string; words: string; roles?: string[] }[] = [
  { title: "Home", to: "/", words: "dashboard start" },
  { title: "Inbox: needs review", to: "/inbox?tab=review", words: "invoices check" },
  { title: "Inbox: on hold", to: "/inbox?tab=hold", words: "blocked held" },
  { title: "Inbox: replies to send", to: "/inbox?tab=answer", words: "answer where's my money questions" },
  { title: "Inbox: all emails", to: "/inbox?tab=emails", words: "mail" },
  { title: "Approvals", to: "/approvals", words: "approve waiting for me" },
  { title: "Payments: ready to pay", to: "/payments?tab=approved", words: "pay prepare approved" },
  { title: "Payments: waiting for release", to: "/payments?tab=prepared", words: "release send" },
  { title: "Payments: on hold", to: "/payments?tab=held", words: "held blocked" },
  { title: "Bank statement", to: "/bank", words: "reconcile fees cheques" },
  { title: "Vendors", to: "/vendors", words: "suppliers onboarding bank changes" },
  { title: "Paid twice", to: "/activity?tab=paid_twice", words: "duplicate overpaid recover double money back" },
  { title: "Tax credits at risk", to: "/activity?tab=tax", words: "gst hst qst pst" },
  { title: "Audit log", to: "/activity?tab=log", words: "history events signed chain" },
  { title: "Try to fool us", to: "/fool", words: "fake fraud forge demo" },
  { title: "System health", to: "/health", words: "slo sli worker queue ocr speed status uptime", roles: ["controller_admin", "auditor"] },
];

/** Every typed word starts some word of the text ("pay rel" → "Payments: waiting for release"). */
function matches(words: string[], text: string): boolean {
  const have = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return words.every((w) => have.some((h) => h.startsWith(w)));
}

const userText = (u: User) => `${u.full_name} ${u.user_id} ${u.title} ${ROLE[u.role] ?? u.role} ${u.role.replace(/_/g, " ")}`;

type Item = { key: string; group: string; icon: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; run: () => void };

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_PALETTE, onOpen); };
  }, []);
  return (
    <Modal open={open} onCancel={() => setOpen(false)} footer={null} closable={false} width={640} destroyOnHidden
      className="palette-modal" title={<span className="sr-only">{t("Search and switch user")}</span>}>
      <Palette close={() => setOpen(false)} />
    </Modal>
  );
}

function Palette({ close }: { close: () => void }) {
  const { users, user, userId, setUserId, today } = useSession();
  const navigate = useNavigate();
  const run = useRunner();
  const { message } = App.useApp();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(0);

  useEffect(() => { input.current?.focus(); }, []);

  // "as elise" = only people. Otherwise every word is searched everywhere.
  const peopleOnly = /^as(\s|$)/i.test(query);
  const words = (peopleOnly ? query.slice(2) : query).toLowerCase().split(/\s+/).filter(Boolean);

  // The server search, 120 ms after the last key. Answers that arrive out of order are dropped.
  useEffect(() => {
    if (peopleOnly || !query.trim()) { setFound(null); return; }
    const n = ++asked.current;
    const t = setTimeout(() => {
      api<SearchResults>(`/search?q=${encodeURIComponent(query.trim())}`)
        .then((r) => { if (n === asked.current) setFound(r); })
        .catch(() => { if (n === asked.current) setFound({ invoices: [], vendors: [] }); });
    }, 120);
    return () => clearTimeout(t);
  }, [query, peopleOnly]);

  const go = (to: string) => () => { close(); navigate(to); };
  const switchTo = (u: User) => () => {
    close();
    setUserId(u.user_id);
    message.success(t("You're now {name} ({role}).", { name: u.full_name, role: t(ROLE[u.role] ?? u.role) }));
  };

  const items = useMemo<Item[]>(() => {
    const recent = readRecent();
    const list: Item[] = [];
    const pages = PAGES.filter((p) => !p.roles || (user && p.roles.includes(user.role)));
    const person = (u: User): Item => ({
      key: `u-${u.user_id}`, group: t("Switch user"), icon: <Avatar name={u.full_name} size="sm" round />,
      title: <>{u.full_name}{u.user_id === userId && <span className="muted"> · {t("you")}</span>}</>,
      sub: `${[u.title, t(ROLE[u.role] ?? u.role)].filter((t, i, all) => all.findIndex((o) => o.toLowerCase() === t.toLowerCase()) === i).join(" · ")}${u.status !== "active" ? ` · ${t(u.status.replace("_", " "))}` : ""}`,
      right: <span className="palette-hint">{t("Switch")}</span>, run: switchTo(u),
    });
    if (peopleOnly) {
      return users.filter((u) => matches(words, userText(u))).slice(0, 12).map(person);
    }
    if (!words.length) {
      for (const r of recent) {
        list.push({ key: `r-${r.key}`, group: t("Recent"), icon: <Avatar name={r.title} size="sm" />, title: r.title, sub: r.sub, run: go(r.to) });
      }
      for (const p of pages) list.push({ key: `p-${p.to}`, group: t("Go to"), icon: <ArrowRightOutlined />, title: t(p.title), run: go(p.to) });
    } else {
      // Vendors first: at most 5, and a name like "harlow" should show both look-alike vendors before their invoices.
      for (const v of found?.vendors ?? []) {
        const s = statusOf(VENDOR_STATUS, v.status);
        list.push({ key: `v-${v.vendor_id}`, group: t("Vendors"), icon: <Avatar name={v.legal_name} size="sm" />, title: v.legal_name,
          sub: v.lookalike_of
            ? <>{v.vendor_id} · <Pill tone="negative">{t("Looks like {name}, but isn't", { name: v.lookalike_of })}</Pill></>
            : <>{v.vendor_id} · {v.category} · <Pill tone={s.tone}>{s.label}</Pill></>, run: go(`/vendors/${v.vendor_id}`) });
      }
      // Recently opened invoices go first among equal matches.
      const seen = new Map(recent.map((r, i) => [r.key, i]));
      const invoices = [...(found?.invoices ?? [])].sort((a, b) => (seen.get(a.invoice_id) ?? 99) - (seen.get(b.invoice_id) ?? 99));
      for (const i of invoices) {
        list.push({ key: `i-${i.invoice_id}`, group: t("Invoices"), icon: <Avatar name={i.vendor_name} size="sm" />,
          title: <>{i.vendor_name ?? t("Unknown vendor")} <span className="muted">· {t(i.is_credit_note ? "credit note" : "invoice")} {i.vendor_invoice_number ?? "—"}</span></>,
          sub: <>{i.invoice_id} · {shortDate(i.invoice_date, today)} · <StatusPill kind="invoice" status={i.status} /></>,
          right: <Money cents={i.total_cents} currency={i.currency} />, run: go(`/invoices/${i.invoice_id}`) });
      }
      for (const u of users.filter((u) => matches(words, userText(u))).slice(0, 4)) list.push(person(u));
      for (const p of pages.filter((p) => matches(words, `${t(p.title)} ${p.title} ${p.words}`))) {
        list.push({ key: `p-${p.to}`, group: t("Go to"), icon: <ArrowRightOutlined />, title: t(p.title), run: go(p.to) });
      }
    }
    const actions: (Item & { words: string })[] = [
      { key: "a-switch", group: t("Actions"), icon: <SwapOutlined />, title: t("Switch user…"), sub: t("Type “as” and a name or a role"),
        words: "switch user login who people role", run: () => { setQuery("as "); setActive(0); input.current?.focus(); } },
      { key: "a-inbox", group: t("Actions"), icon: <ThunderboltOutlined />, title: t("Read new emails"), sub: t("Sort the inbox and start reading the invoices"),
        words: "process inbox import emails intake", run: () => { close(); run(() => send("POST", "/inbox/process"), t("Inbox read"), undefined, { to: "/inbox", label: t("See the inbox") }); } },
      { key: "a-verify", group: t("Actions"), icon: <SafetyCertificateOutlined />, title: t("Verify the audit log"), sub: t("Check every signed event, oldest to newest"),
        words: "audit chain integrity tamper signature verify", run: () => {
          close();
          api<ChainCheck>("/audit/verify")
            .then((c) => (c.ok ? message.success(t("The audit log is intact: {n} events checked.", { n: c.checked })) : message.error({ content: c.reason, duration: 8 })))
            .catch((e: Error) => message.warning(e.message));
        } },
    ];
    for (const a of actions) if (!words.length || matches(words, `${a.title} ${a.words}`)) list.push(a);
    return list;
    // `go`, `switchTo` and `run` are recreated every render but only close over stable things.
  }, [found, query, users, userId, today]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [query, found]);
  useEffect(() => {
    document.getElementById(`palette-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent) => {
    const move = (d: number) => { e.preventDefault(); setActive((a) => (items.length ? (a + d + items.length) % items.length : 0)); };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); items[active].run(); }
  };

  const searching = !peopleOnly && words.length > 0 && found === null;
  return (
    <div className="palette">
      <div className="palette-input">
        <SearchOutlined aria-hidden />
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
          placeholder={t("Invoice number, vendor, amount, page… or “as Elise”")} aria-label={t("Search, or type “as” and a name to switch user")}
          role="combobox" aria-expanded aria-controls="palette-list" aria-autocomplete="list"
          aria-activedescendant={items[active] ? `palette-${active}` : undefined} spellCheck={false} autoComplete="off" />
        <Kbd>Esc</Kbd>
      </div>
      <div className="palette-list" id="palette-list" role="listbox" aria-label={t("Results")}>
        {items.map((it, i) => (
          <div key={it.key}>
            {(i === 0 || items[i - 1].group !== it.group) && <div className="palette-group" role="presentation">{it.group}</div>}
            <div id={`palette-${i}`} role="option" aria-selected={i === active} className={`palette-item ${i === active ? "active" : ""}`}
              onMouseMove={() => i !== active && setActive(i)} onClick={it.run}>
              <span className="palette-icon" aria-hidden>{it.icon}</span>
              <div className="min-0 grow">
                <div className="palette-title">{it.title}</div>
                {it.sub && <div className="palette-sub">{it.sub}</div>}
              </div>
              {it.right && <div className="palette-right">{it.right}</div>}
            </div>
          </div>
        ))}
        {!items.length && !searching && (
          <div className="palette-empty">
            <AppstoreOutlined aria-hidden /> {t("Nothing matches “{q}”. Try an invoice number, a vendor, an amount like 6452.30, or “as” and a name.", { q: query.trim() })}
          </div>
        )}
        {searching && !items.length && <div className="palette-empty">{t("Searching…")}</div>}
      </div>
      <div className="palette-foot hide-touch">
        <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> {t("to move")}</span><span><Kbd>Enter</Kbd> {t("to open")}</span><span>{t("Type")} <Kbd>as</Kbd> {t("and a name to switch user")}</span>
      </div>
    </div>
  );
}
