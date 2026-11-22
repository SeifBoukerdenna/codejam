import { ReloadOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { HealthReport, Latency, Objective } from "../api";
import { EmptyState, Hero, Loading, Page, PageTitle, Panel, Pill, Progress, Section, Stat } from "../components/ui";
import { ago, plural } from "../format";
import { useApi } from "../session";

// System health, for controllers and the auditor: three promises (SLOs) about the machinery, whether we keep them,
// and how much room is left (the error budget). Then the measurements behind them. Calm on purpose: one row per
// promise, and the details below. Everything is measured by the server (health.py); this page only words it.

const pct = (ratio: number | null | undefined, digits = 0) =>
  ratio === null || ratio === undefined ? "—" : `${(ratio * 100).toFixed(digits)}%`;

/** "45 ms", "1.9 s", "4 min" */
function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))} ms`;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  return `${Math.round(seconds / 60)} min`;
}

const UNIT: Record<Objective["name"], [string, string]> = {
  read: ["slow document", "slow documents"], wait: ["late document", "late documents"], audit: ["", ""],
};

function ObjectiveRow({ o, days }: { o: Objective; days: number }) {
  const [one, many] = UNIT[o.name];
  return (
    <div className="slo">
      <div className="slo-head">
        <Pill tone={o.met ? "positive" : "negative"}>{o.met ? "Kept" : "Broken"}</Pill>
        <div className="slo-sentence">{o.sentence}</div>
      </div>
      {o.name === "audit" ? (
        <div className="slo-detail">
          {o.met ? `All ${o.total} events checked, oldest to newest.` : o.bad_example}
          <span className="muted"> No budget: one changed event is a breach.</span>
        </div>
      ) : (
        <>
          <div className="slo-detail">
            {o.total ? `${o.good} of ${o.total} in the last ${days} days (${pct(o.actual, 1)}).` : `Nothing measured in the last ${days} days.`}
            {" "}Budget: {o.budget_allowed} {plural(o.budget_allowed, one, many)} allowed, {o.bad} used,{" "}
            <span className="strong">{pct(o.budget_left)} left</span>.
            {o.bad_example && <span className="muted"> {o.bad_example}.</span>}
          </div>
          <Progress done={Math.round((o.budget_left ?? 0) * 100)} of={100} label={`Error budget left: ${pct(o.budget_left)}`}
            tone={o.met ? "positive" : undefined} />
        </>
      )}
    </div>
  );
}

function SpeedRow({ label, l }: { label: string; l: Latency }) {
  return (
    <div className="speed-row">
      <div className="min-0">
        <div className="strong">{label}</div>
        <div className="small muted">{l.count} {plural(l.count, "document", "documents")}</div>
      </div>
      <div className="speed-figures">
        <div><span className="small muted">Typical</span><span className="num strong">{duration(l.p50)}</span></div>
        <div><span className="small muted">95% within</span><span className="num strong">{duration(l.p95)}</span></div>
        <div><span className="small muted">Slowest</span><span className="num">{duration(l.max)}</span></div>
      </div>
    </div>
  );
}

export default function Health() {
  const { data: h, error, reload } = useApi<HealthReport>("/health/slis");
  if (!h) return <Loading error={error} />;
  const kept = h.objectives.filter((o) => o.met).length;
  const q = h.queue;

  const rail = (
    <>
      <Panel title="Right now">
        <Stat label="Waiting to be read" value={q.waiting ? `${q.waiting} · oldest ${duration(q.oldest_wait_seconds)}` : "Nothing"} />
        <Stat label="Being read" value={q.running.length || "Nothing"} />
        {q.running.map((r) => (
          <div key={r.job_id} className="small mt-2">
            Document {r.document_id} on <span className="num">{r.worker_id}</span>, {duration(r.running_seconds)}
            {r.stale && <> · <Pill tone="negative">Worker stopped answering</Pill>
              <div className="muted">Another worker takes it over after {duration(q.stale_after_seconds)}.</div></>}
          </div>
        ))}
        <Stat label="Failed reads, last 24 h" value={h.failures_24h.length || "None"} />
      </Panel>
      <Panel title="Workers">
        {h.workers.length ? h.workers.map((w) => (
          <Stat key={w.worker_id} label={<span className="num">{w.worker_id}</span>}
            value={<span>{w.jobs} {plural(w.jobs, "document", "documents")} · {ago(w.last_seen)}</span>} />
        )) : <div className="muted">No worker has read anything in {h.window_days} days.</div>}
        <p className="small muted mb-0">Workers share one queue in Postgres, so more can run on any machine that reaches it.</p>
      </Panel>
      <Button className="soft" shape="round" size="large" block icon={<ReloadOutlined />} onClick={reload}>Measure again</Button>
    </>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="System health" />
      <Hero label="Promises kept" value={`${kept} of ${h.objectives.length}`}
        meta={`${kept === h.objectives.length ? "The extraction worker and the audit log are within their objectives."
          : "At least one is broken: fix that before shipping anything else."} Measured ${ago(h.measured_at)}, last ${h.window_days} days.`} />

      <Section title="Objectives" first>
        <div className="slos">{h.objectives.map((o) => <ObjectiveRow key={o.name} o={o} days={h.window_days} />)}</div>
      </Section>

      <Section title="Reading speed" extra={<span>Worker took it → finished</span>}>
        <div className="panel-flat">
          <SpeedRow label="PDFs with text" l={h.latency.text_layer} />
          <SpeedRow label="Scans (3 OCR passes)" l={h.latency.tesseract} />
        </div>
      </Section>

      <Section title="No person needed">
        <p className="m-0">
          <span className="strong">{h.touchless.touchless} of {h.touchless.read} invoices ({pct(h.touchless.rate)})</span> went
          straight to approval: every check passed and every field was read with high confidence.
          The rest waited for a person, each with its reason.
        </p>
      </Section>

      <Section title="How sure we were" extra={<span>{h.confidence.fields} fields read</span>}>
        <div className="bands">
          {h.confidence.bands.map((b) => (
            <div key={b.label} className="band">
              <div className="spread"><span>{b.label}</span><span className="num strong">{b.count}</span></div>
              <Progress done={b.count} of={Math.max(1, h.confidence.fields)} label={`${b.label}: ${b.count} fields`} />
            </div>
          ))}
        </div>
        <p className="small muted mb-0">A field under 90% sends its invoice to a person, who sees what each OCR pass read.</p>
      </Section>

      <Section title="Failed reads, last 24 hours">
        {h.failures_24h.length ? (
          <div className="list">
            {h.failures_24h.map((f) => (
              <div key={f.job_id} className="row">
                <div className="row-main"><div className="row-title">{f.filename}</div><div className="row-sub">{f.error}</div></div>
                <div className="row-end small muted">{ago(f.finished_at)}</div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="Every document was read">Files we can't read fail with a plain sentence and show up here.</EmptyState>}
      </Section>
    </Page>
  );
}
