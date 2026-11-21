import type { PaymentRow as Payment } from "../api";
import { METHOD, PAYMENT_STATUS, money, shortDate, statusOf } from "../format";
import { Avatar, Pill, Row } from "./ui";

/** One payment in a list. Links to its invoice, where the whole story (approvals, checks, audit) lives. */
export default function PaymentRow({ p, today }: { p: Payment; today: string }) {
  const status = statusOf(PAYMENT_STATUS, p.status);
  const when = p.status === "scheduled" || !p.paid_date
    ? `Scheduled ${shortDate(p.scheduled_date, today)}`
    : `Paid ${shortDate(p.paid_date, today)}`;
  const invoice = p.vendor_invoice_number ? `Invoice ${p.vendor_invoice_number}` : p.invoice_id;
  return (
    <Row
      to={`/invoices/${p.invoice_id}`}
      avatar={<Avatar name={p.vendor_name} />}
      title={p.vendor_name}
      sub={`${when} · ${METHOD[p.method] ?? p.method} · ${invoice}`}
      end={
        <>
          <span className="row-amount">{money(p.amount_cents, p.currency)}</span>
          {p.status !== "settled" && p.status !== "scheduled" && <Pill tone={status.tone}>{status.label}</Pill>}
        </>
      }
    />
  );
}
