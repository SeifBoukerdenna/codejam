import type { PaymentRow as Payment } from "../api";
import { METHOD, PAYMENT_STATUS, money, shortDate, statusOf } from "../format";
import { Avatar, Pill, Row } from "./ui";

/** One payment in a list. Links to its invoice, where the whole story lives. */
export default function PaymentRow({ p, today }: { p: Payment; today: string }) {
  const status = statusOf(PAYMENT_STATUS, p.status);
  const when = p.paid_date ? shortDate(p.paid_date, today) : shortDate(p.scheduled_date, today);
  return (
    <Row
      to={`/invoices/${p.invoice_id}`}
      avatar={<Avatar name={p.vendor_name} />}
      title={p.vendor_name}
      sub={p.hold_reason ?? `${when} · ${METHOD[p.method] ?? p.method}`}
      end={<>
        <span className="row-amount">{money(p.amount_cents, p.currency)}</span>
        {/* A badge only where it changes what you'd do: held, waiting for release, uncashed, stopped. */}
        {["held", "prepared", "outstanding", "cancelled"].includes(p.status) && <Pill tone={status.tone}>{status.label}</Pill>}
      </>}
    />
  );
}
