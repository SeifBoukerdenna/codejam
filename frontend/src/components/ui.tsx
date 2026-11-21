import { CheckOutlined, CloseOutlined, CopyOutlined, ExclamationCircleFilled, ExclamationOutlined, InfoCircleFilled,
  MailOutlined, MinusOutlined, StopFilled, CheckCircleFilled, InboxOutlined } from "@ant-design/icons";
import { App, Button } from "antd";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { initials, type Tone } from "../format";

// Every screen is built from these. Need something new? Add it here, not as inline styles on a page.

/** Main column, plus an optional sticky right panel (the "what to do next" side, like a trading ticket).
 *  `head` spans both columns (who/what + the big number), so on a phone the order is head → panel → details. */
export function Page({ children, rail, railFirst, head }: { children: ReactNode; rail?: ReactNode; railFirst?: boolean; head?: ReactNode }) {
  return (
    <div className={`page ${rail ? "" : "solo"} ${railFirst ? "rail-first" : ""}`}>
      {head && <div className="page-head">{head}</div>}
      <div className="content">{children}</div>
      {rail && <aside className="rail">{rail}</aside>}
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

/** The single big number a screen leads with. */
export function Hero({ label, value, meta }: { label: ReactNode; value: ReactNode; meta?: ReactNode }) {
  return (
    <div>
      <div className="hero-label">{label}</div>
      <div className="hero-value num">{value}</div>
      {meta && <div className="hero-meta">{meta}</div>}
    </div>
  );
}

export function Section(props: { title: ReactNode; extra?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section className="section" style={props.first ? { marginTop: 28 } : undefined}>
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

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
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
  return (
    <div className={`avatar ${size ?? ""} ${round ? "round" : ""}`} style={{ background: bg, color: fg }} aria-hidden>
      {initials(name)}
    </div>
  );
}

/** A list row: logo, title + one line of context, amount/status on the right. Link, button, or static. */
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
      <div className="banner-icon">{BANNER_ICON[tone]}</div>
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

export function Check({ tone, children, meta }: { tone: Tone; children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="check">
      <div className={`check-icon ${tone}`}>{CHECK_ICON[tone]}</div>
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

export function Chips<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[];
}) {
  return (
    <div className="chips" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={`chip ${o.value === value ? "on" : ""}`}
          onClick={() => onChange(o.value)}>
          {o.label}{o.count !== undefined && <span className="chip-n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Small cards in a 2-column grid (1 on phones), for a set of choices that each lead somewhere. */
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

export function Empty({ title, children, icon }: { title: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <InboxOutlined />}</div>
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  return (
    <Page>
      {error ? <Notice tone="negative" title="Couldn't load this page">{error}</Notice> : <p className="muted">Loading…</p>}
    </Page>
  );
}
