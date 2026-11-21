import type { AuditEvent } from "../api";
import { Avatar, Loading, Page, PageTitle, Row, Section } from "../components/ui";
import { instant } from "../format";
import { useApi } from "../session";

// Plain-language sentence for each kind of audit event. New actions get a line here when they're added.
function describe(e: AuditEvent): string {
  switch (e.action) {
    case "system.seed": {
      const total = Object.values(e.after ?? {}).reduce<number>((sum, n) => sum + Number(n), 0);
      return `Loaded the Brim dataset (${total.toLocaleString("en-CA")} records)`;
    }
    default:
      return `${e.action.replace(/[._]/g, " ")} · ${e.entity_type} ${e.entity_id}`;
  }
}

export default function Activity() {
  const { data, error } = useApi<AuditEvent[]>("/audit");
  if (!data) return <Loading error={error} />;

  return (
    <Page>
      <PageTitle
        title="Activity"
        subtitle="Every change, who made it and why. This log can't be edited or deleted, not even by an admin."
      />
      <Section title="Latest">
        <div className="list">
          {data.map((e) => (
            <Row
              key={e.event_id}
              avatar={<Avatar name={e.actor_name ?? "System"} />}
              title={describe(e)}
              sub={[
                e.actor_name ?? "System",
                e.on_behalf_of_name && `on behalf of ${e.on_behalf_of_name}`,
                instant(e.created_at),
              ].filter(Boolean).join(" · ")}
              end={e.reason ? <span className="muted small">{e.reason}</span> : undefined}
            />
          ))}
        </div>
      </Section>
    </Page>
  );
}
