import { PaperClipOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Drawer, Upload } from "antd";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { send, type Email, type InvoiceRow } from "../api";
import { useRunner } from "../components/actions";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { ActionButton, Avatar, Check, Chips, Draft, EmptyState, Loading, Money, Notice, Page, PageTitle, Panel, Pill, Progress,
  Row, Section, Stat, StatusPill } from "../components/ui";
import { dateTime, instant, plural, senderName, shortDate, type Tone } from "../format";
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
type Tab = "review" | "hold" | "answer" | "emails";

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
  const toAnswer = emails.data.filter((e) => e.has_reply && e.intake_status === "processed");
  const canWork = user && ["ap_clerk", "finance_manager", "controller_admin"].includes(user.role) && user.status === "active";
  const refresh = () => { emails.reload(); work.reload(); queue.reload(); };
  const byKind = emails.data.reduce<Record<string, number>>((acc, e) => {
    if (e.classification) acc[e.classification] = (acc[e.classification] ?? 0) + 1;
    return acc;
  }, {});
  const totalDocs = (c.done ?? 0) + (c.failed ?? 0) + reading;

  const invoiceColumns: Column<InvoiceRow>[] = [
    { key: "vendor", title: "Vendor", render: (i) => (
      <CellWho avatar={<Avatar name={i.vendor_name} size="sm" />} main={i.vendor_name ?? "Unknown vendor"}
        sub={i.hold_reason ?? `${i.is_credit_note ? "Credit note" : "Invoice"} ${i.vendor_invoice_number ?? ""}`} />) },
    { key: "date", title: "Invoice date", optional: "wide", width: "date", render: (i) => shortDate(i.invoice_date, today) },
    { key: "status", title: "Status", optional: true, width: "status", render: (i) => <StatusPill kind="invoice" status={i.status} /> },
    { key: "amount", title: "Amount", align: "right", width: "amount", render: (i) => <Money cents={i.total_cents} currency={i.currency} /> },
  ];

  const emailRow = (e: Email) => {
    const kind = e.classification ? KIND[e.classification] : null;
    const made = e.invoices ?? [];
    // Badges only where they change what you'd do: a reply waiting to go out, or one that went.
    const badge = e.intake_status === "answered" ? <Pill tone="positive">Answered</Pill>
      : e.has_reply ? <Pill tone="warning">Reply ready</Pill>
        : kind ? <Pill tone={kind.tone}>{made.length > 1 ? `${made.length} invoices` : kind.label}</Pill>
          : e.attachments.length ? <span className="small muted"><PaperClipOutlined aria-label="attachments" /> {e.attachments.length}</span>
            : <Pill tone="warning">No attachment</Pill>;
    return (
      <Row key={e.email_id} onClick={() => setOpenId(e.email_id)}
        avatar={<Avatar name={senderName(e.from_name, e.from_address)} />}
        title={senderName(e.from_name, e.from_address)}
        sub={e.intake_note && e.classification !== "invoice" ? e.intake_note : e.subject}
        end={<><span className="small muted">{dateTime(e.received_at, today)}</span>{badge}</>} />
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
          <Progress done={c.done ?? 0} of={totalDocs} label={`${c.done ?? 0} of ${totalDocs} documents read`} />
        </Panel>
      )}
    </>
  );

  return (
    <Page rail={rail}>
      <PageTitle title="Inbox" />

      {canWork && (
        <div className="cluster mt-5">
          {unsorted > 0 && (
            <ActionButton onRun={() => run(() => send("POST", "/inbox/process"), "Inbox sorted. Reading the invoices now…", refresh,
              { to: "/inbox?tab=review", label: "See what needs review" })}>
              Sort {unsorted} new {plural(unsorted, "email", "emails")}
            </ActionButton>
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
        <div className="panel mt-4" role="status">
          <div className="strong">Reading {reading} {plural(reading, "document", "documents")}…</div>
          <Progress done={c.done ?? 0} of={Math.max(totalDocs, 1)} label="Documents read" />
        </div>
      )}
      {queue.data?.failed.map((f) => <Notice key={f.job_id} tone="negative" title={`Couldn't read ${f.filename}`}>{f.error}</Notice>)}

      <div className="mt-5">
        <Chips<Tab> label="Inbox view" value={tab} onChange={(v) => setParams({ tab: v })} options={[
          { value: "review", label: "To review", count: review.length },
          { value: "hold", label: "On hold", count: held.length },
          ...(emails.data.some((e) => e.has_reply) ? [{ value: "answer" as Tab, label: "To answer", count: toAnswer.length }] : []),
          { value: "emails", label: "Emails", count: emails.data.length },
        ]} />
      </div>

      <div className="mt-5">
        {tab === "review" && (
          <DataTable label="Invoices to review" columns={invoiceColumns} rows={review} rowKey={(i) => i.invoice_id}
            to={(i) => `/invoices/${i.invoice_id}`}
            empty={<EmptyState title="Nothing to review">{unsorted ? "Sort the inbox to bring new invoices in." : undefined}</EmptyState>} />
        )}
        {tab === "hold" && (
          <DataTable label="Invoices on hold" columns={invoiceColumns} rows={held} rowKey={(i) => i.invoice_id}
            to={(i) => `/invoices/${i.invoice_id}`} empty={<EmptyState title="Nothing on hold" />} />
        )}
        {tab === "answer" && (toAnswer.length ? <div className="list">{toAnswer.map(emailRow)}</div>
          : <EmptyState title="Nothing to answer" />)}
        {tab === "emails" && <div className="list">{emails.data.map(emailRow)}</div>}
      </div>
      <EmailDrawer emailId={openId} onClose={() => setOpenId(null)} canWork={!!canWork} onChanged={refresh} />
    </Page>
  );
}

function EmailDrawer({ emailId, onClose, canWork, onChanged }: {
  emailId: string | null; onClose: () => void; canWork: boolean; onChanged: () => void;
}) {
  const { today } = useSession();
  const run = useRunner();
  const { data, reload } = useApi<Email>(emailId ? `/emails/${emailId}` : null);
  const { data: list } = useApi<Email[]>(emailId ? "/emails" : null);
  const email = data && data.email_id === emailId ? data : null;
  const made = list?.find((e) => e.email_id === emailId)?.invoices ?? [];
  return (
    <Drawer open={!!emailId} onClose={onClose} size={540} title={null}>
      {email && (
        <div>
          <h2 className="drawer-title">{email.subject}</h2>
          <p className="muted small m-0">{senderName(email.from_name, email.from_address)} · {email.from_address}</p>
          <p className="muted small m-0">{dateTime(email.received_at, today)}</p>
          {email.intake_note && (
            <div className="panel mt-4">
              <Pill tone={KIND[email.classification ?? "other"]?.tone}>{KIND[email.classification ?? "other"]?.label}</Pill>
              <div className="mt-2">{email.intake_note}</div>
            </div>
          )}
          {email.reply_draft && (
            <Section title={email.intake_status === "answered" ? "Reply sent" : "Reply ready to send"}>
              <Draft text={email.reply_draft} to={email.from_address} subject={`Re: ${email.subject}`}
                actions={canWork && email.intake_status !== "answered" && (
                  <ActionButton size="middle" onRun={() => run(() => send("POST", `/emails/${email.email_id}/answered`), "Marked as answered",
                    () => { reload(); onChanged(); })}>
                    Mark as answered
                  </ActionButton>
                )} />
              {email.intake_status === "answered" && (
                <Check tone="positive" meta={email.answered_at ? instant(email.answered_at) : undefined}>
                  Answered by {email.answered_by_name ?? "AP"}
                </Check>
              )}
            </Section>
          )}
          <Section title="Their email">
            <div className="email-body">{email.body}</div>
          </Section>
          {made.length > 0 && (
            <Section title="Invoices from this email">
              <div className="list">
                {made.map((i) => (
                  <Link key={i.invoice_id} className="row" to={`/invoices/${i.invoice_id}`} onClick={onClose}>
                    <div className="row-main"><div className="row-title">Invoice {i.number ?? i.invoice_id}</div>
                      <div className="row-sub">{i.invoice_id}</div></div>
                    <div className="row-end"><StatusPill kind="invoice" status={i.status} /></div>
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
                    <PaperClipOutlined aria-hidden />
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
