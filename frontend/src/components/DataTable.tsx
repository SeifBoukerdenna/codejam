import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { EmptyState } from "./ui";

// The work queues (Inbox, Payments, Bank, Vendors, Approvals, Audit log) as one table: sticky header, the whole
// row clickable, a selected row you can move with j/k or the arrow keys and open with Enter, the same height
// for every row (skeleton included) so nothing jumps when data arrives.

export type Column<T> = {
  key: string;
  title: ReactNode;
  render: (row: T) => ReactNode;
  align?: "right";
  /** Fixed width for short columns; the first column takes the rest and truncates with "…". */
  width?: "date" | "status" | "amount" | "num" | "method" | "when" | "sig";
  /** Dropped when the TABLE is narrow (container query, not window size): "wide" columns below 720 px of
   *  table, `true` below 480 px. The same table then fits a laptop's main column and a phone. */
  optional?: boolean | "wide";
};

const colClass = <T,>(c: Column<T>) =>
  [c.align === "right" ? "right" : "", c.width ? `w-${c.width}` : "", c.optional === "wide" ? "opt-wide" : c.optional ? "optional" : ""]
    .filter(Boolean).join(" ");

/** The list an invoice was opened from, so [ and ] on the invoice page step through the same list. */
export const QUEUE_KEY = "harborline:queue";
export function readQueue(): { label: string; paths: string[] } | null {
  try { return JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? "null"); } catch { return null; }
}

export function DataTable<T>({ columns, rows, rowKey, to, onOpen, label, empty, loading, linkColumn, onRowHover }: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  /** Where a row leads. The first column also renders as a real link, so Tab + Enter work without the table keys. */
  to?: (row: T) => string | undefined;
  onOpen?: (row: T) => void;
  /** Read by screen readers, e.g. "Invoices to review". */
  label: string;
  empty?: ReactNode;
  loading?: boolean;
  /** Which column gets the link (defaults to the first). */
  linkColumn?: string;
  /** Called with the row under the pointer (or focus), and null when it leaves. */
  onRowHover?: (row: T | null) => void;
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState(-1);
  const body = useRef<HTMLTableSectionElement>(null);
  const clickable = !!(to || onOpen);
  const list = rows ?? [];

  // Remember this list when one of its invoices is opened (sessionStorage: this tab only, gone when it closes).
  const remember = () => {
    const paths = list.map((r) => to?.(r)).filter((p): p is string => !!p && p.startsWith("/invoices/"));
    if (paths.length) {
      try { sessionStorage.setItem(QUEUE_KEY, JSON.stringify({ label, paths })); } catch { /* private mode: no stepping */ }
    }
  };
  const open = (row: T) => {
    remember();
    if (onOpen) onOpen(row);
    else { const target = to?.(row); if (target) navigate(target); }
  };

  useEffect(() => {
    body.current?.querySelectorAll("tr")[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!list.length) return;
    const move = (d: number) => { e.preventDefault(); setSelected((s) => Math.max(0, Math.min(list.length - 1, s + d))); };
    if (e.key === "j" || e.key === "ArrowDown") move(1);
    else if (e.key === "k" || e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" && selected >= 0 && clickable) { e.preventDefault(); open(list[selected]); }
  };

  const linkKey = linkColumn ?? columns[0]?.key;
  return (
    <div className="dt-wrap" tabIndex={0} onKeyDown={onKeyDown}
      aria-label={`${label}. ${clickable ? "Use j and k or the arrow keys to move, Enter to open." : ""}`}>
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => <th key={c.key} scope="col" className={colClass(c)}>{c.title}</th>)}
          </tr>
        </thead>
        <tbody ref={body}>
          {loading && !rows && Array.from({ length: 5 }, (_, i) => (
            <tr key={`s${i}`}>
              {columns.map((c) => <td key={c.key} className={colClass(c)}><div className="skeleton skeleton-line" /></td>)}
            </tr>
          ))}
          {!loading && rows && rows.length === 0 && (
            <tr><td colSpan={columns.length}>{empty ?? <EmptyState title="Nothing here" />}</td></tr>
          )}
          {list.map((row, i) => {
            const target = to?.(row);
            return (
              <tr key={rowKey(row)} className={`${clickable ? "clickable" : ""} ${i === selected ? "selected" : ""}`}
                aria-selected={i === selected}
                onMouseEnter={onRowHover && (() => onRowHover(row))} onMouseLeave={onRowHover && (() => onRowHover(null))}
                onClick={(e) => {
                  setSelected(i);
                  if ((e.target as HTMLElement).closest("a, button")) { remember(); return; }   // real links act themselves
                  if (clickable) open(row);
                }}>
                {columns.map((c) => (
                  <td key={c.key} className={colClass(c)}>
                    {c.key === linkKey && target ? <Link to={target} className="block">{c.render(row)}</Link> : c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The usual first cell: logo, main line, one line of context. */
export function CellWho({ avatar, main, sub }: { avatar?: ReactNode; main: ReactNode; sub?: ReactNode }) {
  return (
    <div className="cell-who">
      {avatar}
      <div className="min-0">
        <div className="cell-main">{main}</div>
        {sub && <div className="cell-sub">{sub}</div>}
      </div>
    </div>
  );
}
