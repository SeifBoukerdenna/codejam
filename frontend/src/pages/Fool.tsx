import { CheckOutlined, CloseOutlined, DownloadOutlined, ExclamationOutlined, LoadingOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Upload } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { send, type FoolAttempt, type FoolPage, type FoolResult } from "../api";
import { useRunner } from "../components/actions";
import { Avatar, Card, Cards, Hero, Loading, Page, PageTitle, Panel, Pill, Row, Section } from "../components/ui";
import { ago, money, type Tone } from "../format";
import { useApi } from "../session";

// "Try to fool us": judges forge an invoice or a bank change and watch the normal checks stop it.
// This page only launches fakes and reads the results. It has no say in whether something is caught.

const RESULT: Record<FoolResult, { label: string; tone: Tone; icon: ReactNode }> = {
  caught: { label: "Caught", tone: "positive", icon: <CheckOutlined /> },
  unreadable: { label: "Couldn't read it", tone: "warning", icon: <ExclamationOutlined /> },
  got_through: { label: "Got through", tone: "negative", icon: <CloseOutlined /> },
  reading: { label: "Reading…", tone: "neutral", icon: <LoadingOutlined /> },
};

const linkTo = (a: FoolAttempt) =>
  a.invoice_id ? `/invoices/${a.invoice_id}` : a.vendor_id ? `/vendors/${a.vendor_id}` : undefined;

export default function Fool() {
  const page = useApi<FoolPage>("/fool");
  const run = useRunner();
  const [launching, setLaunching] = useState<string | null>(null);
  const d = page.data;
  const reading = d?.attempts.some((a) => a.result === "reading") ?? false;

  // The worker reads fakes in the background: poll until every attempt has a result.
  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(page.reload, 1200);
    return () => clearTimeout(timer);
  }, [reading, page]);

  if (!d) return <Loading error={page.error} />;

  const allowed = d.can_try.allowed;
  const tryIt = async (key: string) => {
    setLaunching(key);
    await run(() => send("POST", `/fool/${key}`), "Sent. Watch it go through the checks…", page.reload);
    setLaunching(null);
  };
  const latest = (key: string) => d.attempts.find((a) => a.scenario === key);
  const recent = d.attempts.slice(0, 24).reverse();   // the score bar, oldest on the left

  const rail = (
    <Panel title="Make your own">
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 14 }}>
        Take a real invoice, change anything you like, and upload it.
      </p>
      {d.samples.length > 0 && (
        <div className="list">
          {d.samples.map((s) => (
            <a key={s.document_id} className="row" href={`/api/documents/${s.document_id}/file?download=1`}>
              <Avatar name={s.vendor_name} size="sm" />
              <div className="row-main">
                <div className="row-title">{s.vendor_name}</div>
                <div className="row-sub">{money(s.total_cents, s.currency)}</div>
              </div>
              <DownloadOutlined style={{ color: "var(--ink-3)" }} />
            </a>
          ))}
        </div>
      )}
      <div className="panel-actions">
        <Upload accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" showUploadList={false} disabled={!allowed}
          customRequest={async ({ file, onSuccess, onError }) => {
            const body = new FormData();
            body.append("file", file as Blob);
            const ok = await run(() => send("POST", "/documents", body), "Uploaded. Reading it now…", page.reload);
            if (ok) onSuccess?.({}); else onError?.(new Error("upload failed"));
          }}>
          <Button type="primary" shape="round" size="large" icon={<UploadOutlined />} disabled={!allowed} block>
            Upload your fake
          </Button>
        </Upload>
      </div>
      {!allowed && <div className="reason">{d.can_try.reason}</div>}
    </Panel>
  );

  // The title and score are the page head, so on a phone the upload panel comes right after them.
  const head = (
    <>
      <PageTitle title="Try to fool us" />
      <div style={{ marginTop: 26 }}>
        {d.finished > 0 ? (
          <Hero label="Fakes caught" value={`${d.caught} of ${d.finished}`}
            meta={<span>{d.caught === d.finished ? "None of them could be paid." : `${d.finished - d.caught} got through.`}</span>} />
        ) : (
          <Hero label="Ready to try" value={`${d.scenarios.length} tricks`}
            meta={<span>Each fake goes through the same reading and checks as a real invoice.</span>} />
        )}
        {recent.length > 0 && (
          <div className="score-bar" aria-hidden>
            {recent.map((a) => (
              <span key={a.id} className={a.result === "reading" ? "pending" : a.result === "got_through" ? "negative" : "positive"} />
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <Page rail={rail} head={head}>
      <Section title="Tricks">
        <Cards>
          {d.scenarios.map((s) => {
            const a = latest(s.key);
            const busy = launching === s.key || a?.result === "reading";
            return (
              <Card key={s.key} title={s.title} foot={
                a && a.result !== "reading" ? (
                  <div className="card-result">
                    <div className={`check-icon ${RESULT[a.result].tone}`}>{RESULT[a.result].icon}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="card-result-title">{RESULT[a.result].label}</div>
                      <div className="card-result-text">{a.reasons[0] ?? "No check stopped it."}</div>
                      <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
                        {linkTo(a) && <Link className="card-result-link" to={linkTo(a)!}>See how</Link>}
                        {allowed && <button className="link-button" onClick={() => tryIt(s.key)}>Try again</button>}
                      </div>
                    </div>
                  </div>
                ) : (
                  <Button className="soft" shape="round" disabled={!allowed || busy} onClick={() => tryIt(s.key)}
                    icon={busy ? <LoadingOutlined /> : undefined}>
                    {busy ? "Reading it…" : "Try it"}
                  </Button>
                )
              }>
                {s.pitch}
              </Card>
            );
          })}
        </Cards>
      </Section>

      {d.attempts.length > 0 && (
        <Section title="Every attempt">
          <div className="list">
            {d.attempts.map((a) => {
              const r = RESULT[a.result];
              return (
                <Row key={a.id} to={linkTo(a)} avatar={<Avatar name={a.vendor_name ?? a.title} />}
                  title={a.scenario ? `${a.title} · ${a.vendor_name ?? ""}` : a.title}
                  sub={a.result === "reading" ? "Reading the document…" : a.reasons[0] ?? "No check stopped it."}
                  end={<><Pill tone={r.tone}>{r.label}</Pill><span className="small muted">{ago(a.created_at)}</span></>} />
              );
            })}
          </div>
        </Section>
      )}
    </Page>
  );
}
