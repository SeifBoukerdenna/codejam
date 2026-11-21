import { useState } from "react";
import type { MonthTotal } from "../api";
import { money, monthName, plural } from "../format";

// Money paid out per month, as columns. Hand-drawn SVG instead of a chart library: about 100 lines that
// anyone on the team can read, and no extra dependency.
//
// Spec: one series in one colour (no legend; the hero label above names it), columns at most 24px wide with
// a 4px rounded top and a square base, hairline gridlines, compact y-axis ticks, a tooltip per column on
// hover AND keyboard focus, and a plain table behind "Show numbers" so no value needs the mouse.
// The current month is drawn lighter because it isn't over yet.

const W = 680;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 28, left: 48 };
const BAR_MAX = 24;

function niceStep(max: number): number {
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

export default function MonthlyBars({ data, today }: { data: MonthTotal[]; today: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  if (data.length === 0) return null;

  const currentMonth = today.slice(0, 7);
  const max = Math.max(...data.map((d) => d.total_cad_cents), 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  const barW = Math.min(BAR_MAX, band * 0.6);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  const label = (d: MonthTotal) =>
    `${monthName(d.month, true)}${d.month === currentMonth ? " so far" : ""} · ${d.count} ${plural(d.count, "payment", "payments")}`;

  const activeBar = active === null ? null : data[active];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Money paid out per month">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--ink-3)"
              style={{ fontVariantNumeric: "tabular-nums" }}>
              {money(t, "CAD", true)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const cx = PAD.left + band * i + band / 2;
          const h = Math.max(0, y(0) - y(d.total_cad_cents));
          const x = cx - barW / 2;
          const yTop = y(0) - h;
          const r = Math.min(4, h, barW / 2);
          const partial = d.month === currentMonth;
          // Column path: rounded top corners, square bottom on the baseline.
          const path = h <= 0 ? "" :
            `M${x},${y(0)} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} ` +
            `Q${x + barW},${yTop} ${x + barW},${yTop + r} V${y(0)} Z`;
          return (
            <g key={d.month}>
              <path d={path} fill={active === i ? "var(--accent-strong)" : "var(--accent)"}
                opacity={partial ? 0.4 : 1} />
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={12} fill="var(--ink-3)">
                {monthName(d.month)}
              </text>
              {/* Hit area: the whole column band, much bigger than the bar itself. */}
              <rect className="bar-hit" x={PAD.left + band * i} y={PAD.top} width={band} height={plotH}
                fill="transparent" tabIndex={0} aria-label={`${money(d.total_cad_cents)}, ${label(d)}`}
                onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)} onBlur={() => setActive(null)} />
            </g>
          );
        })}
      </svg>

      {activeBar && active !== null && (
        <div className="chart-tooltip" style={{
          left: `${((PAD.left + band * active + band / 2) / W) * 100}%`,
          top: `${(y(activeBar.total_cad_cents) / H) * 100}%`,
        }}>
          <strong>{money(activeBar.total_cad_cents)}</strong>
          <span>{label(activeBar)}</span>
        </div>
      )}

      <div className="chart-foot">
        <span>{data.at(-1)?.month === currentMonth ? "Lighter bar: this month so far." : ""}</span>
        <button className="text-button" onClick={() => setShowTable((s) => !s)}>
          {showTable ? "Hide numbers" : "Show numbers"}
        </button>
      </div>

      {showTable && (
        <table className="mini-table">
          <thead><tr><th>Month</th><th className="num">Payments</th><th className="num">Paid out</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.month}>
                <td>{monthName(d.month, true)}{d.month === currentMonth ? " (so far)" : ""}</td>
                <td className="num">{d.count}</td>
                <td className="num">{money(d.total_cad_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
