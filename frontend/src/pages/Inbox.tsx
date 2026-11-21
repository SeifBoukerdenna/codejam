import { LoadingOutlined, PaperClipOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Drawer, Segmented, Upload } from "antd";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { send, type Email, type InvoiceRow } from "../api";
import { useRunner } from "../components/actions";
import { Avatar, Empty, Loading, Notice, Page, PageTitle, Pill, Row, Section } from "../components/ui";
import { INVOICE_STATUS, dateTime, money, plural, senderName, shortDate, statusOf, type Tone } from "../format";
import { useApi, useSession } from "../session";

// The AP clerk's workspace: everything that came in, what the system made of it, and what needs a person.

const KIND: Record<string, { label: string; tone: Tone }> = {
  invoice: { label: "Invoice", tone: "info" },
  statement: { label: "Statement · filed", tone: "neutral" },
  newsletter: { label: "Newsletter · ignored", tone: "neutral" },
  payment_inquiry: { label: "Payment question", tone: "warning" },
  missing_attachment: { label: "Missing attachment", tone: "warning" },
  other: { label: "Needs a person", tone: "warning" },
};

type Queue = { counts: Record<string, number>; failed: { job_id: number; filename: string; error: string }[] };

export default function Inbox() {
  const { today, user } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "review";
  const run = useRunner();
  const emails = useApi<Email[]>("/emails");
  const work = useApi<InvoiceRow[]>("/invoices?status=needs_review,on_hold,extracting");
  const queue = useApi<Queue>("/inbox/queue");
  const [openId, setOpenId] = useState<string | null>(null);
  const reading = (queue.data?.counts.queued ?? 0) + (queue.data?.counts.running ?? 0);

  // While the worker is reading documents, refresh every 2 seconds so invoices appear as they're read.
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

  const invoiceRow = (i: InvoiceRow) => (
    <Row key={i.invoice_id} to={`/invoices/${i.invoice_id}`} avatar={<Avatar name={i.vendor_name} />}
      title={i.vendor_name ?? "Unknown vendor"}
      sub={i.hold_reason ?? `${i.is_credit_note ? "Credit note" : "Invoice"} ${i.vendor_invoice_number ?? ""} · ${shortDate(i.invoice_date, today)}`}
      end={<><span className="row-amount">{money(i.total_cents, i.currency)}</span>
        <Pill tone={statusOf(INVOICE_STATUS, i.status).tone}>{statusOf(INVOICE_STATUS, i.status).label}</Pill></>} />
  );

  return (
    <Page>
      <PageTitle title="Inbox" subtitle={`${emails.data.length} emails · ${review.length} to review · ${held.length} on hold`} />

      {canWork && (
        <div className="section" style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
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
            <Button shape="round" size="large" icon={<UploadOutlined />}>Upload an invoice</Button>
          </Upload>
        </div>
      )}

      {reading > 0 && (
        <Notice tone="info" title={<><LoadingOutlined /> Reading {reading} {plural(reading, "document", "documents")}…</>}>
          The extraction worker reads the PDF text, or OCRs scans. Invoices appear below as they're done.
        </Notice>
      )}
      {queue.data?.failed.map((f) => (
        <Notice key={f.job_id} tone="negative" title={`Couldn't read ${f.filename}`}>{f.error}</Notice>
      ))}

      <div className="section" style={{ marginTop: 28 }}>
        <Segmented size="large" value={tab} onChange={(v) => setParams({ tab: String(v) })}
          options={[{ value: "review", label: `To review · ${review.length}` }, { value: "hold", label: `On hold · ${held.length}` },
            { value: "emails", label: `Emails · ${emails.data.length}` }]} />
      </div>

      {tab === "review" && (
        <Section title="To review" caption="Something needs a person: a warning to acknowledge, or a field we're not sure we read right.">
          {review.length ? <div className="list">{review.map(invoiceRow)}</div>
            : <Empty title="Nothing to review">{unsorted ? "Sort the inbox to bring new invoices in." : "All clear."}</Empty>}
        </Section>
      )}
      {tab === "hold" && (
        <Section title="On hold" caption="Blocked by a rule: duplicate, wrong tax, unknown vendor, unverified bank change…">
          {held.length ? <div className="list">{held.map(invoiceRow)}</div> : <Empty title="Nothing on hold" />}
        </Section>
      )}
      {tab === "emails" && (
        <Section title="Emails">
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
                    <span className="muted small">{dateTime(e.received_at, today)}</span>
                    {kind ? <Pill tone={kind.tone}>{made.length > 1 ? `${made.length} invoices` : kind.label}</Pill>
                      : e.attachments.length > 0
                        ? <span className="muted small"><PaperClipOutlined /> {e.attachments.length} {plural(e.attachments.length, "file", "files")}</span>
                        : <Pill tone="warning">No attachment</Pill>}
                  </>} />
              );
            })}
          </div>
        </Section>
      )}
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
    <Drawer open={!!emailId} onClose={onClose} size={560} title={null}>
      {email && (
        <div>
          <h2 className="page-title" style={{ fontSize: 30 }}>{email.subject}</h2>
          <p className="muted" style={{ margin: 0 }}>From {senderName(email.from_name, email.from_address)} &lt;{email.from_address}&gt;</p>
          <p className="muted small" style={{ margin: 0 }}>{dateTime(email.received_at, today)} · {email.email_id}</p>
          {email.intake_note && (
            <Notice tone={email.classification === "invoice" ? "info" : "warning"}
              title={KIND[email.classification ?? "other"]?.label ?? "Sorted"}>{email.intake_note}</Notice>
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
          <Section title="Attachments">
            {email.attachments.length === 0 ? <p className="muted">This email has no attachment.</p> : (
              <div className="list">
                {email.attachments.map((name) => (
                  <a key={name} className="row" target="_blank" rel="noreferrer"
                    href={`/api/emails/${email.email_id}/attachments/${encodeURIComponent(name)}`}>
                    <PaperClipOutlined />
                    <div className="row-main"><div className="row-title">{name}</div></div>
                    <div className="row-end muted small">Open</div>
                  </a>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
}
