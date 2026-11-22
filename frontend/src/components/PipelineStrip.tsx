import { CheckOutlined, ExclamationOutlined } from "@ant-design/icons";
import type { PipelineStep } from "./invoiceStory";

const STATE_WORD = { done: "done", current: "in progress", blocked: "blocked", todo: "not yet" } as const;

/** Received → Read → Checked → Approved → Paid. The current step stands out; a blocked one says why. */
export default function PipelineStrip({ steps }: { steps: PipelineStep[] }) {
  return (
    <ol className="pipeline" aria-label="Where this invoice is">
      {steps.map((s, i) => (
        <li key={s.key} className={`pipeline-step ${s.state}`} aria-current={s.state === "current" || s.state === "blocked" ? "step" : undefined}>
          <span className="pipeline-mark" aria-hidden>
            {s.state === "done" ? <CheckOutlined /> : s.state === "blocked" ? <ExclamationOutlined /> : i + 1}
          </span>
          <div className="min-0">
            <div className="pipeline-label">{s.label}<span className="sr-only">: {STATE_WORD[s.state]}</span></div>
            <div className="pipeline-sub">{s.sub}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
