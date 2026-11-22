import { CheckOutlined, CloseOutlined, CopyOutlined, ExclamationCircleFilled, ExclamationOutlined, InfoCircleFilled,
  MailOutlined, MinusOutlined, StopFilled, CheckCircleFilled, InboxOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Breakdown, Permission } from "../api";
import { INVOICE_STATUS, PAYMENT_STATUS, initials, moneyParts, statusOf, type Tone } from "../format";

// Every screen is built from these. Need something new? Add it here (and its style in styles.css), never as
// inline styles on a page.

/** Main column, plus an optional sticky right panel (the "what to do next" side, like a trading ticket).
 *  `head` spans both columns (who/what + the big number), so on a phone the order is head → panel → details. */
export function Page({ children, rail, railFirst, head }: { children: ReactNode; rail?: ReactNode; railFirst?: boolean; head?: ReactNode }) {
  return (
    <div className={`page ${rail ? "" : "solo"} ${railFirst ? "rail-first" : ""}`}>
      {head && <div className="page-head">{head}</div>}
      <div className="content">{children}</div>
      {rail && <aside className="rail" aria-label="What to do next">{rail}</aside>}
    </div>
  );
}

export function PageTitle({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <header>
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-sub">{subtitle}</p>}
    </header>
  );
}

/** An amount from the API, in integer cents. Always labelled CAD or USD; a credit is marked with a minus and
 *  "credit" for screen readers, never by colour alone. `breakdown` shows the server's arithmetic on hover/focus. */
export type { Breakdown };

/** `inLink`: the amount sits inside a link, where a second focus stop is invalid HTML; the breakdown then shows on
 *  hover only, and the page the link opens shows the same numbers with keyboard access. */
export function Money({ cents, currency = "CAD", breakdown, credit, inLink }: {
  cents: number | null | undefined; currency?: string; breakdown?: Breakdown | null; credit?: boolean; inLink?: boolean;
}) {
  if (cents === null || cents === undefined) return <span className="money">—</span>;
  const { sign, amount } = moneyParts(cents);
  const isCredit = credit ?? cents < 0;
  const body = (
    <span className={`money ${isCredit ? "credit" : ""} ${breakdown ? "has-breakdown" : ""}`}
      tabIndex={breakdown && !inLink ? 0 : undefined}
      aria-label={breakdown && !inLink ? `${sign}$${amount} ${currency}, show the calculation` : undefined}>
      {sign}${amount}<span className="money-ccy">{currency}</span>
      {isCredit && <span className="sr-only"> credit</span>}
    </span>
  );
  if (!breakdown) return body;
  return (
    <Tooltip title={<BreakdownView breakdown={breakdown} total={breakdown.total_cents ?? cents} currency={currency} />}
      trigger={inLink ? ["hover"] : ["hover", "focus"]}>
      {body}
    </Tooltip>
  );
}

function BreakdownView({ breakdown, total, currency }: { breakdown: Breakdown; total: number; currency: string }) {
  const show = (c: number) => { const p = moneyParts(c); return `${p.sign}$${p.amount}`; };
  return (
    <div className="breakdown">
      {breakdown.parts.map((p) => (
        <div className="breakdown-row" key={p.label}><span>{p.label}</span><span>{show(p.cents)}</span></div>
      ))}
      <div className="breakdown-row total"><span>{breakdown.total_label ?? "Total"}</span><span>{show(total)} {currency}</span></div>
      {breakdown.note && <div className="breakdown-note">{breakdown.note}</div>}
    </div>
  );
}

/** Counts up to the final value once, under 600 ms, then shows exactly the API's number.
 *  DECISION: the in-between values are only animation frames; the number that stays on screen is the one the
 *  server sent. Skipped entirely when the person asked for reduced motion. */
function useCountUp(cents: number, enabled: boolean): number {
  const [frame, setFrame] = useState<number | null>(enabled ? 0 : null);   // null = not animating: show `cents`
  const started = useRef(!enabled);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setFrame(null); return; }
    const start = performance.now();
    let id = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 550);
      setFrame(t < 1 ? Math.round(cents * (1 - (1 - t) ** 3)) : null);
      if (t < 1) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(id); setFrame(null); };
  }, [cents]);
  return frame ?? cents;
}

/** The single big number a screen leads with. Pass `cents` for money (with an optional one-time count-up),
 *  or `value` for anything else ("9 of 9"). */
export function Hero({ label, value, cents, currency, countUp, meta, breakdown }: {
  label: ReactNode; value?: ReactNode; cents?: number; currency?: string; countUp?: boolean; meta?: ReactNode; breakdown?: Breakdown | null;
}) {
  const shown = useCountUp(cents ?? 0, !!countUp);
  return (
    <div className="hero">
      <div className="hero-label">{label}</div>
      <div className="hero-value">
        {cents !== undefined ? <Money cents={countUp ? shown : cents} currency={currency} breakdown={breakdown} /> : value}
      </div>
      {meta && <div className="hero-meta">{meta}</div>}
    </div>
  );
}

export function Section(props: { title: ReactNode; extra?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section className={`section ${props.first ? "first" : ""}`}>
      <div className="section-head">
        <h2 className="section-title">{props.title}</h2>
        {props.extra && <div className="section-extra">{props.extra}</div>}
      </div>
      {props.children}
    </section>
  );
}

export function Panel({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      {title && <h3 className="panel-title">{title}</h3>}
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: ReactNode; value: ReactNode }) {
  return <div className="panel-stat"><span>{label}</span><span>{value}</span></div>;
}

/** Status everywhere: a small dot + a word. Colour only adds to the word, never replaces it. */
export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** An invoice or payment status, with the same word and colour on every page. */
export function StatusPill({ kind, status }: { kind: "invoice" | "payment"; status: string }) {
  const s = statusOf(kind === "invoice" ? INVOICE_STATUS : PAYMENT_STATUS, status);
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

// A muted colour per vendor/person, always the same for the same name, like a brand logo would be.
const SWATCHES = [
  ["#e8effc", "#2c56a8"], ["#e5f5ec", "#17703f"], ["#fdf0e0", "#9a5500"], ["#f1eafd", "#653cba"],
  ["#fde8eb", "#ad2440"], ["#e3f4f4", "#0f6b6b"], ["#efefec", "#45453f"], ["#fdf6d8", "#7f6400"],
];
function swatch(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}

export function Avatar({ name, size, round, dark }: { name: string | null | undefined; size?: "sm" | "lg"; round?: boolean; dark?: boolean }) {
  const [bg, fg] = dark ? ["#111111", "#ffffff"] : swatch(name ?? "?");
  // Inline styles are only for values computed at runtime (this colour, progress widths); everything else is a class.
  return (
    <div className={`avatar ${size ?? ""} ${round ? "round" : ""}`} style={{ background: bg, color: fg }} aria-hidden>
      {initials(name)}
    </div>
  );
}

/** Who/what a detail page is about: logo, name, one line of context. */
export function EntityHead({ avatar, title, sub }: { avatar: ReactNode; title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="entity-head mb-5">
      {avatar}
      <div className="min-0">
        <div className="entity-title">{title}</div>
        {sub && <div className="muted small">{sub}</div>}
      </div>
    </div>
  );
}

/** A list row: logo, title + one line of context, amount/status on the right. Link, button, or static.
 *  Used on Home and in side panels; work queues use DataTable. */
export function Row(props: { avatar?: ReactNode; title: ReactNode; sub?: ReactNode; end?: ReactNode; to?: string; onClick?: () => void }) {
  const content = (
    <>
      {props.avatar}
      <div className="row-main">
        <div className="row-title">{props.title}</div>
        {props.sub && <div className="row-sub">{props.sub}</div>}
      </div>
      {props.end && <div className="row-end">{props.end}</div>}
    </>
  );
  if (props.to) return <Link className="row" to={props.to}>{content}</Link>;
  if (props.onClick) return <button className="row" onClick={props.onClick}>{content}</button>;
  return <div className="row">{content}</div>;
}

const BANNER_ICON: Record<Tone, ReactNode> = {
  negative: <StopFilled />, warning: <ExclamationCircleFilled />, positive: <CheckCircleFilled />,
  info: <InfoCircleFilled />, neutral: <InfoCircleFilled />,
};

/** For the few things that stop money. Icon + words, never colour alone. */
export function Notice({ tone = "neutral", title, children }: { tone?: Tone; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === "negative" ? "alert" : undefined}>
      <div className="banner-icon" aria-hidden>{BANNER_ICON[tone]}</div>
      <div>
        <div className="banner-title">{title}</div>
        {children && <div className="banner-body">{children}</div>}
      </div>
    </div>
  );
}

const CHECK_ICON: Record<Tone, ReactNode> = {
  positive: <CheckOutlined />, warning: <ExclamationOutlined />, negative: <CloseOutlined />,
  info: <MinusOutlined />, neutral: <MinusOutlined />,
};
const CHECK_WORD: Record<Tone, string> = { positive: "Passed", warning: "Needs a look", negative: "Blocks", info: "Note", neutral: "Note" };

export function Check({ tone, children, meta }: { tone: Tone; children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="check">
      <div className={`check-icon ${tone}`} role="img" aria-label={CHECK_WORD[tone]}>{CHECK_ICON[tone]}</div>
      <div className="check-text">{children}{meta && <div className="check-meta">{meta}</div>}</div>
    </div>
  );
}

export function Tiles({ items }: { items: { label: ReactNode; value: ReactNode; note?: ReactNode }[] }) {
  return (
    <div className="tiles">
      {items.map((t, i) => (
        <div className="tile" key={i}>
          <div className="tile-label">{t.label}</div>
          <div className="tile-value">{t.value}</div>
          {t.note && <div className="tile-note">{t.note}</div>}
        </div>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label?: string;
}) {
  return (
    <div className="chips" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={`chip ${o.value === value ? "on" : ""}`}
          onClick={() => onChange(o.value)}>
          {o.label}{o.count !== undefined && <span className="chip-n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A button for an action the server may refuse: pending state while it runs, and when not allowed it stays
 *  visible, disabled, with the server's reason under it. */
export function ActionButton({ perm, onRun, children, kind = "primary", size = "large", icon }: {
  perm?: Permission; onRun: () => Promise<unknown> | unknown; children: ReactNode;
  kind?: "primary" | "soft" | "danger"; size?: "middle" | "large"; icon?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const refused = perm !== undefined && perm !== null && !perm.allowed;
  return (
    <>
      <Button type={kind === "primary" ? "primary" : "default"} className={kind === "soft" ? "soft" : kind === "danger" ? "danger-soft" : undefined}
        shape="round" size={size} icon={icon} loading={busy} disabled={refused}
        onClick={async () => { setBusy(true); try { await onRun(); } finally { setBusy(false); } }}>
        {children}
      </Button>
      {refused && <div className="reason">{perm!.reason}</div>}
    </>
  );
}

/** A single-use virtual card, drawn as a card: what it's locked to is printed on its face. */
export function CardFace({ last4, expires, amount, lockedTo, status }: {
  last4: string; expires: string; amount: string; lockedTo: string; status: "active" | "used" | "cancelled";
}) {
  return (
    <div className={`cardface ${status}`} role="img"
      aria-label={`Single-use card ending ${last4}, exactly ${amount}, only at ${lockedTo}, expires ${expires}${status !== "active" ? `, ${status}` : ""}`}>
      <div className="cardface-top">
        <div><div className="cardface-brand">Brim</div><div className="cardface-label">Single-use</div></div>
        <div className="right-text"><div className="cardface-label">Exactly</div><div className="cardface-amount num">{amount}</div></div>
      </div>
      <div className="cardface-number num">•••• •••• •••• {last4}</div>
      <div className="cardface-bottom">
        <div className="min-0">
          <div className="cardface-label">Only at</div>
          <div className="cardface-value">{lockedTo}</div>
        </div>
        <div className="right-text">
          <div className="cardface-label">Expires</div>
          <div className="cardface-value num">{expires}</div>
        </div>
      </div>
      {status !== "active" && <div className="cardface-stamp">{status === "used" ? "Used" : "Cancelled"}</div>}
    </div>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="cards">{children}</div>;
}

export function Card({ title, children, foot }: { title: ReactNode; children?: ReactNode; foot?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {children && <div className="card-body">{children}</div>}
      {foot && <div className="card-foot">{foot}</div>}
    </div>
  );
}

async function copyText(text: string) {
  // navigator.clipboard only exists on https/localhost; the fallback covers a phone on the LAN (http://192.168…).
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = Object.assign(document.createElement("textarea"), { value: text });
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

/** A message we wrote for a person to send, shown exactly as it will read. We never send it ourselves:
 *  AP sends it from their own mailbox, so the vendor gets a reply from a person they know. */
export function Draft({ text, to, subject, actions }: { text: string; to?: string; subject?: string; actions?: ReactNode }) {
  const { message } = App.useApp();
  const mailto = to && `mailto:${to}?subject=${encodeURIComponent(subject ?? "")}&body=${encodeURIComponent(text)}`;
  return (
    <div className="draft">
      {to && <div className="draft-field"><span>To</span>{to}</div>}
      {subject && <div className="draft-field"><span>Subject</span>{subject}</div>}
      <div className="draft-body">{text}</div>
      <div className="draft-actions">
        <Button className="soft" shape="round" icon={<CopyOutlined />}
          onClick={() => copyText(text).then(() => message.success("Copied"), () => message.error("Couldn't copy"))}>Copy</Button>
        {mailto && <Button className="soft" shape="round" icon={<MailOutlined />} href={mailto}>Open in mail app</Button>}
        {actions}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>{icon ?? <InboxOutlined />}</div>
      <div className="empty-title">{title}</div>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** Grey placeholders shaped like the content, so nothing jumps when the data arrives. */
export function Skeleton({ lines = 3, hero }: { lines?: number; hero?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {hero && <div className="skeleton skeleton-hero" />}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton skeleton-line" />
      ))}
    </div>
  );
}

/** A count-based bar (never money): how much of something is done. */
export function Progress({ done, of, label, tone }: { done: number; of: number; label: string; tone?: "positive" }) {
  return (
    <div className={`progress ${tone ?? ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={done} aria-label={label}>
      {/* Runtime width, like the avatar colour: the only kind of inline style we allow. */}
      <div style={{ width: `${of ? (done / of) * 100 : 0}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Loading({ error }: { error?: string | null }) {
  return (
    <Page>
      {error ? <Notice tone="negative" title="Couldn't load this page">{error}</Notice> : <Skeleton hero lines={6} />}
    </Page>
  );
}
