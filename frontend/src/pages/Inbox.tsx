import { PaperClipOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Drawer, Upload } from "antd";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { send, type Email, type InvoiceRow } from "../api";
import { useRunner } from "../components/actions";
import { Avatar, Chips, Empty, Loading, Notice, Page, PageTitle, Panel, Pill, Row, Section, Stat } from "../components/ui";
import { INVOICE_STATUS, dateTime, money, plural, senderName, shortDate, statusOf, type Tone } from "../format";
import { useApi, useSession } from "../session";

// The AP clerk's workspace: what came in, what the system made of it, and what needs a person.

const KIND: Record<string, { label: string; tone: Tone }> = {
  invoice: { label: "Invoice", tone: "info" },
  statement: { label: "Statement", tone: "neutral" },
  newsletter: { label: "Newsletter", tone: "neutral" },
  payment_inquiry: { label: "Payment question", tone: "warning" },
  missing_attachment: { label: "No attachment", tone: "warning" },
  other: { label: "Needs a person", tone: "warning" },
};

type Queue = { counts: Record<string, number>; failed: { job_id: number; filename: string; error: string }[] };
type Tab = "review" | "hold" | "emails";

export default function Inbox() {
  const { today, user } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "review";
  const run = useRunner();
  const emails = useApi<Email[]>("/emails");
  const work = useApi<InvoiceRow[]>("/invoices?status=needs_review,on_hold,extracting");
  const queue = useApi<Queue>("/inbox/queue");
  const [openId, setOpenId] = useState<string | null>(null);
  const c = queue.data?.counts ?? {};
  const reading = (c.queued ?? 0) + (c.running ?? 0);

  // While the worker reads, refresh every 2 s so invoices appear as they're done.
  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => { queue.reload(); work.reload(); emails.reload(); }, 2000);
    return () => clearTimeout(timer);
  }, [reading, queue, work, emails]);

  if (!emails.data || !work.data) return <Loading error={emails.error ?? work.error} />;

  const unsorted = emails.data.filter((e) => e.intake_status === "unprocessed").length;
  const review = work.data.filter((i) => i.status === "needs_review");
  const held = work.data.filter((i) => i.status === "on_hold");
  const canWork = user && ["ap_clerk", "finance_manager", "controller_admin"].includes(user.role) && user.status === "active";
  const refresh = () => { emails.reload(); work.reload(); queue.reload(); };
  const byKind = emails.data.reduce<Record<string, number>>((acc, e) => {
    if (e.classification) acc[e.classification] = (acc[e.classification] ?? 0) + 1;
    return acc;
  }, {});
  const totalDocs = (c.done ?? 0) + (c.failed ?? 0) + reading;

  const invoiceRow = (i: InvoiceRow) => {
    const s = statusOf(INVOICE_STATUS, i.status);
    return (
      <Row key={i.invoice_id} to={`/invoices/${i.invoice_id}`} avatar={<Avatar name={i.vendor_name} />}
        title={i.vendor_name ?? "Unknown vendor"}
        sub={i.hold_reason ?? `${i.is_credit_note ? "Credit note" : "Invoice"} ${i.vendor_invoice_number ?? ""} · ${shortDate(i.invoice_date, today)}`}
        end={<><span className="row-amount">{money(i.total_cents, i.currency)}</span><Pill tone={s.tone}>{s.label}</Pill></>} />
    );
  };

  const rail = (
    <>
      <Panel title="Sorted">
        {Object.keys(byKind).length === 0 ? <div className="muted">{unsorted} emails waiting to be sorted.</div> : (
          <>
            <Stat label="Invoices" value={byKind.invoice ?? 0} />
            <Stat label="Payment questions" value={byKind.payment_inquiry ?? 0} />
            <Stat label="Missing attachment" value={byKind.missing_attachment ?? 0} />
            <Stat label="Statements" value={byKind.statement ?? 0} />
            <Stat label="Newsletters" value={byKind.newsletter ?? 0} />
          </>
        )}
      </Panel>
      {totalDocs > 0 && (
        <Panel title="Documents read">
          <Stat label="Read" value={`${c.done ?? 0} of ${totalDocs}`} />
          <div className="progress"><div style={{ width: `${((c.done ?? 0) / totalDocs) * 100}%` }} /></div>
        </Panel>
      )}
    </>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="Inbox" />

      {canWork && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
          {unsorted > 0 && (
            <Button type="primary" shape="round" size="large"
              onClick={() => run(() => send("POST", "/inbox/process"), "Inbox sorted. Reading the invoices now…", refresh)}>
              Sort {unsorted} new {plural(unsorted, "email", "emails")}
            </Button>
          )}
          <Upload accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" showUploadList={false}
            customRequest={async ({ file, onSuccess, onError }) => {
              const body = new FormData();
              body.append("file", file as Blob);
              const ok = await run(() => send("POST", "/documents", body), "Uploaded. Reading it now…", refresh);
              if (ok) onSuccess?.({}); else onError?.(new Error("upload failed"));
            }}>
            <Button className="soft" shape="round" size="large" icon={<UploadOutlined />}>Upload an invoice</Button>
          </Upload>
        </div>
      )}

      {reading > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div style={{ fontWeight: 600 }}>Reading {reading} {plural(reading, "document", "documents")}…</div>
          <div className="progress"><div style={{ width: `${((c.done ?? 0) / Math.max(totalDocs, 1)) * 100}%` }} /></div>
        </div>
      )}
      {queue.data?.failed.map((f) => <Notice key={f.job_id} tone="negative" title={`Couldn't read ${f.filename}`}>{f.error}</Notice>)}

      <div style={{ marginTop: 26 }}>
        <Chips<Tab> value={tab} onChange={(v) => setParams({ tab: v })} options={[
          { value: "review", label: "To review", count: review.length },
          { value: "hold", label: "On hold", count: held.length },
          { value: "emails", label: "Emails", count: emails.data.length },
        ]} />
      </div>

      <Section title={tab === "review" ? "To review" : tab === "hold" ? "On hold" : "Emails"} first>
        {tab === "review" && (review.length ? <div className="list">{review.map(invoiceRow)}</div>
          : <Empty title="Nothing to review">{unsorted ? "Sort the inbox to bring new invoices in." : undefined}</Empty>)}
        {tab === "hold" && (held.length ? <div className="list">{held.map(invoiceRow)}</div> : <Empty title="Nothing on hold" />)}
        {tab === "emails" && (
          <div className="list">
            {emails.data.map((e) => {
              const kind = e.classification ? KIND[e.classification] : null;
              const made = e.invoices ?? [];
              return (
                <Row key={e.email_id} onClick={() => setOpenId(e.email_id)}
                  avatar={<Avatar name={senderName(e.from_name, e.from_address)} />}
                  title={senderName(e.from_name, e.from_address)}
                  sub={e.intake_note && e.classification !== "invoice" ? e.intake_note : e.subject}
                  end={<>
                    <span className="small muted">{dateTime(e.received_at, today)}</span>
                    {kind ? <Pill tone={kind.tone}>{made.length > 1 ? `${made.length} invoices` : kind.label}</Pill>
                      : e.attachments.length ? <span className="small muted"><PaperClipOutlined /> {e.attachments.length}</span>
                        : <Pill tone="warning">No attachment</Pill>}
                  </>} />
              );
            })}
          </div>
        )}
      </Section>
      <EmailDrawer emailId={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}

function EmailDrawer({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const { today } = useSession();
  const { data } = useApi<Email>(emailId ? `/emails/${emailId}` : null);
  const { data: list } = useApi<Email[]>(emailId ? "/emails" : null);
  const email = data && data.email_id === emailId ? data : null;
  const made = list?.find((e) => e.email_id === emailId)?.invoices ?? [];
  return (
    <Drawer open={!!emailId} onClose={onClose} size={540} title={null}>
      {email && (
        <div>
          <h2 className="drawer-title">{email.subject}</h2>
          <p className="muted small" style={{ margin: 0 }}>{senderName(email.from_name, email.from_address)} · {email.from_address}</p>
          <p className="muted small" style={{ margin: 0 }}>{dateTime(email.received_at, today)}</p>
          {email.intake_note && (
            <div className="panel" style={{ marginTop: 18 }}>
              <Pill tone={KIND[email.classification ?? "other"]?.tone}>{KIND[email.classification ?? "other"]?.label}</Pill>
              <div style={{ marginTop: 8, fontSize: 14.5 }}>{email.intake_note}</div>
            </div>
          )}
          <div className="email-body">{email.body}</div>
          {made.length > 0 && (
            <Section title="Invoices from this email">
              <div className="list">
                {made.map((i) => (
                  <Link key={i.invoice_id} className="row" to={`/invoices/${i.invoice_id}`} onClick={onClose}>
                    <div className="row-main"><div className="row-title">Invoice {i.number ?? i.invoice_id}</div>
                      <div className="row-sub">{i.invoice_id}</div></div>
                    <div className="row-end"><Pill tone={statusOf(INVOICE_STATUS, i.status).tone}>{statusOf(INVOICE_STATUS, i.status).label}</Pill></div>
                  </Link>
                ))}
              </div>
            </Section>
          )}
          {email.attachments.length > 0 && (
            <Section title="Attachments">
              <div className="list">
                {email.attachments.map((name) => (
                  <a key={name} className="row" target="_blank" rel="noreferrer"
                    href={`/api/emails/${email.email_id}/attachments/${encodeURIComponent(name)}`}>
                    <PaperClipOutlined />
                    <div className="row-main"><div className="row-title">{name}</div></div>
                    <div className="row-end small muted">Open</div>
                  </a>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </Drawer>
  );
}
