import { Button, Drawer } from "antd";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { send, type BankLine, type BankPage } from "../api";
import { useRunner } from "../components/actions";
import { CellWho, DataTable, type Column } from "../components/DataTable";
import { ActionButton, Avatar, Check, Chips, Draft, EmptyState, Hero, Loading, Money, Page, PageTitle, Panel, Pill, Progress,
  Row, Section, Stat, Tiles } from "../components/ui";
import { instant, longDate, plural, shortDate } from "../format";
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
  const totals = d.todo_totals;
  const perm = d.can_act.allowed ? undefined : { allowed: false, reason: d.can_act.reason ?? "" };
  const shown = { open, done, matched }[tab];

  const columns: Column<BankLine>[] = [
    { key: "what", title: "What it is", render: (l) => (
      <CellWho avatar={<Avatar name={l.vendor_name ?? "Bank"} size="sm" round={!l.vendor_name} dark={!l.vendor_name} />}
        main={l.kind === "matched" ? l.vendor_name : l.title} sub={l.description} />) },
    { key: "date", title: "Date", optional: "wide", width: "date", render: (l) => shortDate(l.posted_date, today) },
    { key: "status", title: "To do", width: "status", render: (l) => l.todo ? <Pill tone={l.tone === "negative" ? "negative" : "warning"}>{TODO_LABEL[l.todo]}</Pill>
      : l.resolution ? <Pill tone="neutral">{RESOLUTION_LABEL[l.resolution]}</Pill> : <Pill tone="positive">Matched</Pill> },
    { key: "amount", title: "Debit", align: "right", width: "amount", render: (l) => <Money cents={l.amount_cents} /> },
  ];

  const rail = (
    <Panel title="What to do">
      {open.length === 0 ? (
        <Check tone="positive">Every debit on the statement is explained.</Check>
      ) : (
        <>
          {totals.ask_bank.count > 0 && <Stat label={`Ask the bank about ${totals.ask_bank.count} debits`} value={<Money cents={totals.ask_bank.cents} />} />}
          {totals.book_fee.count > 0 && <Stat label={`Book ${totals.book_fee.count} bank ${plural(totals.book_fee.count, "fee", "fees")}`} value={<Money cents={totals.book_fee.cents} />} />}
          {totals.mark_cashed.count > 0 && <Stat label={`Mark ${totals.mark_cashed.count} ${plural(totals.mark_cashed.count, "cheque", "cheques")} cashed`} value={<Money cents={totals.mark_cashed.cents} />} />}
          <div className="panel-actions">
            {totals.ask_bank.count > 0 && <ActionButton perm={perm} onRun={() => setWriting(true)}>Write to the bank</ActionButton>}
            {totals.book_fee.count > 0 && (
              <ActionButton kind="soft" perm={perm} onRun={() => run(() => send("POST", "/bank/book-fees"), `Booked to ${d.bank_fee_account}`, page.reload)}>
                Book fees to {d.bank_fee_account}
              </ActionButton>
            )}
            {totals.mark_cashed.count > 0 && (
              <ActionButton kind="soft" perm={perm} onRun={() => run(() => send("POST", "/bank/cheques-cashed"), "Cheques marked as cashed", page.reload)}>
                Mark cheques cashed
              </ActionButton>
            )}
          </div>
        </>
      )}
    </Panel>
  );

  // Title and the big number are the page head, so on a phone the "What to do" panel comes right after them.
  const head = (
    <>
      <PageTitle title="Bank statement" />
      <div className="mt-5">
        <Hero label="Debits we can't explain" cents={d.in_question_cents} breakdown={d.in_question_breakdown}
          meta={<span>{!d.unexplained_cents && d.waiting_cents ? "Asked the bank, waiting for their answer · "
            : !d.unexplained_cents ? "Every debit is explained · " : ""}
            {d.matched} of {d.lines.length} debits match a payment · {shortDate(d.statement_from, today)} to {shortDate(d.statement_to, today)}</span>} />
        <Progress done={d.lines.length - open.length} of={d.lines.length} tone="positive"
          label={`${d.lines.length - open.length} of ${d.lines.length} debits explained`} />
      </div>
    </>
  );

  return (
    <Page rail={rail} railFirst head={head}>
      {d.missing_from_statement.map((m) => (
        <Check key={m.payment_id} tone="negative">
          {m.payment_id} to {m.vendor_name} (<Money cents={m.amount_cents} />) was marked paid on {longDate(m.paid_date)},
          but it never left the account.
        </Check>
      ))}
      <Chips<Tab> label="Bank lines" value={tab} onChange={(v) => setParams({ tab: v })} options={[
        { value: "open", label: "To explain", count: open.length },
        { value: "done", label: "Handled", count: done.length },
        { value: "matched", label: "Matched", count: matched.length },
      ]} />
      <div className="mt-5">
        <DataTable label={{ open: "Bank debits to explain", done: "Bank debits handled", matched: "Bank debits matched to a payment" }[tab]}
          columns={columns} rows={shown} rowKey={(l) => l.bank_txn_id} onOpen={(l) => setOpenId(l.bank_txn_id)}
          empty={<EmptyState title={tab === "open" ? "Nothing left to explain" : tab === "done" ? "Nothing handled yet" : "No matches yet"}>
            {tab === "done" ? "Fees you book, debits you ask the bank about and cheques you mark cashed land here, with who did it." : undefined}
          </EmptyState>} />
      </div>

      <LineDrawer line={d.lines.find((l) => l.bank_txn_id === openId) ?? null} onClose={() => setOpenId(null)} />

      <Drawer open={writing} onClose={() => setWriting(false)} size={560} title={null}>
        <h2 className="drawer-title">Write to the bank</h2>
        <p className="muted mb-5 m-0">
          {totals.ask_bank.count} {plural(totals.ask_bank.count, "debit", "debits")}, with the date, amount and trace of each.
        </p>
        <Draft text={d.letter} subject="Debits on our business account we can't explain"
          actions={d.can_act.allowed && (
            <ActionButton size="middle" onRun={() => run(() => send("POST", "/bank/ask"), "Marked as sent to the bank",
              () => { page.reload(); setWriting(false); }, { to: "/bank?tab=done", label: "See what was asked" })}>Mark as sent</ActionButton>
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
          <div className="mt-4">
            <Hero label={longDate(line.posted_date)} cents={line.amount_cents}
              meta={line.at_stake_cents !== line.amount_cents && line.todo
                ? <span><Money cents={line.at_stake_cents} /> more than we sent</span> : undefined} />
          </div>
          <div className="checks mt-2">
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
