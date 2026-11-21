import { CheckCircleFilled, ExclamationCircleFilled, InfoCircleFilled, StopFilled } from "@ant-design/icons";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { initials, type Tone } from "../format";

// The handful of building blocks every page is made of. If a page needs something that isn't here, add it
// here rather than styling it inline, so all screens stay consistent.

export function Page({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>;
}

export function PageTitle({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <header>
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </header>
  );
}

/** The single big number a screen leads with. */
export function Hero({ label, value, caption }: { label: ReactNode; value: ReactNode; caption?: ReactNode }) {
  return (
    <div>
      <div className="hero-label">{label}</div>
      <div className="hero-value">{value}</div>
      {caption && <div className="hero-caption">{caption}</div>}
    </div>
  );
}

export function Section(props: { title: ReactNode; extra?: ReactNode; caption?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">{props.title}</h2>
        {props.extra && <div className="section-extra">{props.extra}</div>}
      </div>
      {props.caption && <p className="section-caption">{props.caption}</p>}
      {props.children}
    </section>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Avatar({ name, size, dark }: { name: string | null | undefined; size?: "small" | "large"; dark?: boolean }) {
  return (
    <div className={`avatar ${size ?? ""} ${dark ? "dark" : ""}`} aria-hidden>
      {initials(name)}
    </div>
  );
}

/** A list row: optional avatar, title + subtitle on the left, amount/status on the right.
 *  Pass `to` to make the whole row a link, or `onClick` to make it a button. */
export function Row(props: {
  avatar?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  to?: string;
  onClick?: () => void;
}) {
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

const NOTICE_ICON: Record<Tone, ReactNode> = {
  negative: <StopFilled />,
  warning: <ExclamationCircleFilled />,
  positive: <CheckCircleFilled />,
  info: <InfoCircleFilled />,
  neutral: <InfoCircleFilled />,
};

/** A problem or fact, explained in a sentence. Icon + words, so it never relies on colour alone. */
export function Notice({ tone = "neutral", title, children }: { tone?: Tone; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === "negative" ? "alert" : undefined}>
      <div className="notice-icon">{NOTICE_ICON[tone]}</div>
      <div>
        <div className="notice-title">{title}</div>
        {children && <div className="notice-body">{children}</div>}
      </div>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <CheckCircleFilled />}</div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** Shown while the first response is loading, or if it failed. */
export function Loading({ error }: { error?: string | null }) {
  if (error) {
    return (
      <Page>
        <Notice tone="negative" title="Couldn't load this page">{error}</Notice>
      </Page>
    );
  }
  return <Page><p className="muted">Loading…</p></Page>;
}
