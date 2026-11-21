import { PaperClipOutlined } from "@ant-design/icons";
import { Drawer } from "antd";
import { useState } from "react";
import type { Email } from "../api";
import { Avatar, Loading, Page, PageTitle, Pill, Row, Section } from "../components/ui";
import { dateTime, plural, senderName } from "../format";
import { useApi, useSession } from "../session";

// Everything that arrived in ap@harborline. Step 2 adds sorting (invoice / statement / newsletter /
// question / missing attachment) and turns attachments into invoices; for now it shows the raw inbox.
export default function Inbox() {
  const { today } = useSession();
  const { data, error } = useApi<Email[]>("/emails");
  const [openId, setOpenId] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;

  const unsorted = data.filter((e) => e.intake_status === "unprocessed").length;

  return (
    <Page>
      <PageTitle
        title="Inbox"
        subtitle={`${data.length} emails · ${unsorted} not sorted yet`}
      />
      <Section title="Latest">
        <div className="list">
          {data.map((e) => (
            <Row
              key={e.email_id}
              onClick={() => setOpenId(e.email_id)}
              avatar={<Avatar name={senderName(e.from_name, e.from_address)} />}
              title={senderName(e.from_name, e.from_address)}
              sub={e.subject}
              end={
                <>
                  <span className="muted small">{dateTime(e.received_at, today)}</span>
                  {e.attachments.length > 0 ? (
                    <span className="muted small"><PaperClipOutlined /> {e.attachments.length} {plural(e.attachments.length, "file", "files")}</span>
                  ) : (
                    <Pill tone="warning">No attachment</Pill>
                  )}
                </>
              }
            />
          ))}
        </div>
      </Section>
      <EmailDrawer emailId={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}

function EmailDrawer({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const { today } = useSession();
  const { data } = useApi<Email>(emailId ? `/emails/${emailId}` : null);
  const email = data && data.email_id === emailId ? data : null;
  return (
    <Drawer open={!!emailId} onClose={onClose} size={560} title={null}>
      {email && (
        <div>
          <h2 className="page-title" style={{ fontSize: 30 }}>{email.subject}</h2>
          <p className="muted" style={{ margin: 0 }}>
            From {senderName(email.from_name, email.from_address)} &lt;{email.from_address}&gt;
          </p>
          <p className="muted small" style={{ margin: 0 }}>{dateTime(email.received_at, today)} · {email.email_id}</p>
          <div className="email-body">{email.body}</div>
          <Section title="Attachments">
            {email.attachments.length === 0 ? (
              <p className="muted">This email has no attachment.</p>
            ) : (
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
