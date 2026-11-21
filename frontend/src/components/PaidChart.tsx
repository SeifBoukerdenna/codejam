import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { shortDate } from "../format";

// "Paid to vendors this year" as a running total, like a portfolio-value chart: one line, a soft wash under
// it, no axes. Hovering (or arrow keys) moves a crosshair and the page's big number follows it.
// Hand-drawn SVG instead of a chart library: ~100 lines anyone on the team can read.

export type Point = { date: string; cents: number };
export type Range = "1M" | "3M" | "YTD";

const W = 680;
const H = 220;
const PAD_Y = 14;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Running total for every day from Jan 1 to today (days with no payment repeat yesterday's total). */
export function cumulative(daily: { date: string; total_cad_cents: number }[], today: string): Point[] {
  const byDay = new Map(daily.map((d) => [d.date, d.total_cad_cents]));
  const out: Point[] = [];
  let running = 0;
  for (let d = `${today.slice(0, 4)}-01-01`; d <= today; d = addDays(d, 1)) {
    running += byDay.get(d) ?? 0;
    out.push({ date: d, cents: running });
  }
  return out;
}

export function inRange(points: Point[], range: Range, today: string): Point[] {
  if (range === "YTD") return points;
  const start = addDays(today, range === "1M" ? -30 : -91);
  return points.filter((p) => p.date >= start);
}

export default function PaidChart({ points, range, onRange, onPoint }: {
  points: Point[]; range: Range; onRange: (r: Range) => void; onPoint: (p: Point | null) => void;
}) {
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    const min = Math.min(...points.map((p) => p.cents));
    const max = Math.max(...points.map((p) => p.cents));
    const span = max - min || 1;
    const x = (i: number) => (points.length < 2 ? 0 : (i / (points.length - 1)) * W);
    const y = (c: number) => PAD_Y + (H - 2 * PAD_Y) * (1 - (c - min) / span);
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join(" ");
    return { x, y, line, area: `${line} L${W},${H} L0,${H} Z` };
  }, [points]);

  const pick = (i: number | null) => {
    setActive(i);
    onPoint(i === null ? null : points[i]);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    pick(Math.round(ratio * (points.length - 1)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") pick(Math.max(0, (active ?? points.length) - 1));
    else if (e.key === "ArrowRight") pick(Math.min(points.length - 1, (active ?? -1) + 1));
    else if (e.key === "Escape") pick(null);
    else return;
    e.preventDefault();
  };

  if (points.length < 2) return null;
  const a = active === null ? null : points[active];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0}
        aria-label={`Money paid out, running total, ${range}. Use the arrow keys to read values.`}
        onPointerMove={onMove} onPointerLeave={() => pick(null)} onKeyDown={onKey} onBlur={() => pick(null)}
        style={{ outline: "none" }}>
        <defs>
          <linearGradient id="paid-wash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#111111" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#111111" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.area} fill="url(#paid-wash)" />
        <path d={geo.line} fill="none" stroke="#111111" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {a && active !== null && (
          <>
            <line x1={geo.x(active)} x2={geo.x(active)} y1={0} y2={H} stroke="#c9c9c4" strokeWidth={1} />
            <circle cx={geo.x(active)} cy={geo.y(a.cents)} r={5} fill="#111111" stroke="#ffffff" strokeWidth={2} />
          </>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="chart-ranges">
          {(["1M", "3M", "YTD"] as Range[]).map((r) => (
            <button key={r} className={r === range ? "on" : ""} onClick={() => onRange(r)}>{r}</button>
          ))}
        </div>
        <span className="small muted">{shortDate(points[0].date)} – {shortDate(points.at(-1)!.date)}</span>
      </div>
    </div>
  );
}
