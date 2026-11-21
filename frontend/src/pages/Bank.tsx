import { Button, Drawer } from "antd";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { send, type BankLine, type BankPage } from "../api";
import { useRunner } from "../components/actions";
import { Avatar, Check, Chips, Draft, Empty, Hero, Loading, Page, PageTitle, Panel, Pill, Row, Section, Stat, Tiles } from "../components/ui";
import { instant, longDate, money, plural, shortDate } from "../format";
import { useApi, useSession } from "../session";

// Every debit on the bank statement, matched to a payment we made or explained in plain words.
// What can't be explained becomes one email to the bank, written for you, with every date and amount in it.

const TODO_LABEL = { ask_bank: "Ask the bank", book_fee: "Book it", mark_cashed: "Mark cashed" } as const;
const RESOLUTION_LABEL = { asked_bank: "Asked the bank", fee_booked: "Booked", cheque_cashed: "Marked cashed" } as const;
// What needs the bank's answer first, then our own bookkeeping.
const ORDER: BankLine["kind"][] = ["unknown_debit", "amount_differs", "unmatched", "fee_without_cause", "cheque_cashed", "bank_fee"];

type Tab = "open" | "done" | "matched";

export default function Bank() {
  const { today } = useSession();
  const page = useApi<BankPage>("/bank");
  const run = useRunner();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "open";
  const [openId, setOpenId] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const d = page.data;
  if (!d) return <Loading error={page.error} />;

  const open = d.lines.filter((l) => l.todo).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const done = d.lines.filter((l) => l.resolution);
  const matched = d.lines.filter((l) => l.kind === "matched");
  const ask = open.filter((l) => l.todo === "ask_bank");
  const fees = open.filter((l) => l.todo === "book_fee");
  const cheques = open.filter((l) => l.todo === "mark_cashed");
  const allowed = d.can_act.allowed;
  const act = (path: string, done: string) => run(() => send("POST", path), done, page.reload);
  const shown = { open, done, matched }[tab];

  const rail = (
    <Panel title="What to do">
      {open.length === 0 ? (
        <Check tone="positive">Every debit on the statement is explained.</Check>
      ) : (
        <>
          {ask.length > 0 && <Stat label={`Ask the bank about ${ask.length} debits`} value={money(ask.reduce((n, l) => n + l.at_stake_cents, 0))} />}
          {fees.length > 0 && <Stat label={`Book ${fees.length} bank ${plural(fees.length, "fee", "fees")}`} value={money(fees.reduce((n, l) => n + l.amount_cents, 0))} />}
          {cheques.length > 0 && <Stat label={`Mark ${cheques.length} ${plural(cheques.length, "cheque", "cheques")} cashed`} value={money(cheques.reduce((n, l) => n + l.amount_cents, 0))} />}
          <div className="panel-actions">
            {ask.length > 0 && <Button type="primary" shape="round" size="large" disabled={!allowed} onClick={() => setWriting(true)}>Write to the bank</Button>}
            {fees.length > 0 && (
              <Button className="soft" shape="round" size="large" disabled={!allowed}
                onClick={() => act("/bank/book-fees", `Booked to ${d.bank_fee_account}`)}>Book fees to {d.bank_fee_account}</Button>
            )}
            {cheques.length > 0 && (
              <Button className="soft" shape="round" size="large" disabled={!allowed}
                onClick={() => act("/bank/cheques-cashed", "Cheques marked as cashed")}>Mark cheques cashed</Button>
            )}
          </div>
          {!allowed && <div className="reason">{d.can_act.reason}</div>}
        </>
      )}
    </Panel>
  );

  // Title and the big number are the page head, so on a phone the "What to do" panel comes right after them.
  const head = (
    <>
      <PageTitle title="Bank statement" />
      <div style={{ marginTop: 26 }}>
        <Hero label="Debits we can't explain" value={money(d.unexplained_cents + d.waiting_cents)}
          meta={<span>{!d.unexplained_cents && d.waiting_cents ? "Asked the bank, waiting for their answer · "
            : !d.unexplained_cents ? "Every debit is explained · " : ""}
            {d.matched} of {d.lines.length} debits match a payment · {shortDate(d.statement_from, today)} to {shortDate(d.statement_to, today)}</span>} />
        <div className="progress"><div style={{ width: `${((d.lines.length - open.length) / d.lines.length) * 100}%`, background: "var(--green)" }} /></div>
      </div>
    </>
  );

  return (
    <Page rail={rail} railFirst head={head}>

      {d.missing_from_statement.map((m) => (
        <Check key={m.payment_id} tone="negative">
          <Link to={`/invoices/${m.invoice_id}`}>{m.payment_id}</Link> to {m.vendor_name} ({money(m.amount_cents)}) was marked paid
          on {longDate(m.paid_date)}, but it never left the account.
        </Check>
      ))}

      <div style={{ marginTop: 26 }}>
        <Chips<Tab> value={tab} onChange={(v) => setParams({ tab: v })} options={[
          { value: "open", label: "To explain", count: open.length },
          { value: "done", label: "Handled", count: done.length },
          { value: "matched", label: "Matched", count: matched.length },
        ]} />
      </div>

      <Section title={{ open: "To explain", done: "Handled", matched: "Matched to a payment" }[tab]} first>
        {shown.length ? (
          <div className="list">
            {shown.map((l) => (
              <Row key={l.bank_txn_id} onClick={() => setOpenId(l.bank_txn_id)}
                avatar={<Avatar name={l.vendor_name ?? "Bank"} round={!l.vendor_name} dark={!l.vendor_name} />}
                title={l.kind === "matched" ? l.vendor_name : l.title}
                sub={`${shortDate(l.posted_date, today)} · ${l.description}`}
                end={<>
                  <span className="row-amount">{money(l.amount_cents)}</span>
                  {l.todo ? <Pill tone={l.tone === "negative" ? "negative" : "warning"}>{TODO_LABEL[l.todo]}</Pill>
                    : l.resolution ? <Pill tone="neutral">{RESOLUTION_LABEL[l.resolution]}</Pill> : null}
                </>} />
            ))}
          </div>
        ) : <Empty title={tab === "open" ? "Nothing left to explain" : "Nothing here yet"} />}
      </Section>

      <LineDrawer line={d.lines.find((l) => l.bank_txn_id === openId) ?? null} onClose={() => setOpenId(null)} />

      <Drawer open={writing} onClose={() => setWriting(false)} size={560} title={null}>
        <h2 className="drawer-title">Write to the bank</h2>
        <p className="muted" style={{ margin: "0 0 18px" }}>
          {ask.length} {plural(ask.length, "debit", "debits")}, with the date, amount and trace of each.
        </p>
        <Draft text={d.letter} subject="Debits on our business account we can't explain"
          actions={allowed && (
            <Button type="primary" shape="round" onClick={() => run(() => send("POST", "/bank/ask"), "Marked as sent to the bank",
              () => { page.reload(); setWriting(false); })}>Mark as sent</Button>
          )} />
      </Drawer>
    </Page>
  );
}

function LineDrawer({ line, onClose }: { line: BankLine | null; onClose: () => void }) {
  return (
    <Drawer open={!!line} onClose={onClose} size={500} title={null}>
      {line && (
        <div>
          <Pill tone={line.tone}>{line.title}</Pill>
          <div style={{ marginTop: 14 }}>
            <Hero label={longDate(line.posted_date)} value={money(line.amount_cents)}
              meta={line.at_stake_cents !== line.amount_cents && line.todo
                ? <span><b style={{ color: "var(--red)" }}>{money(line.at_stake_cents)}</b> more than we sent</span> : undefined} />
          </div>
          <div className="checks" style={{ marginTop: 8 }}>
            <Check tone={line.tone}>{line.explanation}</Check>
            {line.resolution && (
              <Check tone="positive" meta={line.resolved_at ? instant(line.resolved_at) : undefined}>
                {RESOLUTION_LABEL[line.resolution]}{line.resolved_by_name ? ` by ${line.resolved_by_name}` : ""}
              </Check>
            )}
          </div>
          <Section title="On the statement">
            <Tiles items={[
              { label: "Bank line", value: line.bank_txn_id },
              { label: "Description", value: line.description },
            ]} />
          </Section>
          {line.invoice_id && (
            <Section title="Our payment">
              <div className="list">
                <Row to={`/invoices/${line.invoice_id}`} avatar={<Avatar name={line.vendor_name} />}
                  title={line.vendor_name} sub={`${line.payment_id} · invoice ${line.invoice_id}`} end={<span className="small muted">Open</span>} />
              </div>
            </Section>
          )}
        </div>
      )}
    </Drawer>
  );
}
