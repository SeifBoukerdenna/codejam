import type { PaymentRow as Payment } from "../api";
import { METHOD, shortDate } from "../format";
import { Avatar, Money, Row, StatusPill } from "./ui";

/** One payment in a list (Home). Links to its invoice, where the whole story lives. */
export default function PaymentRow({ p, today }: { p: Payment; today: string }) {
  const when = p.paid_date ? shortDate(p.paid_date, today) : shortDate(p.scheduled_date, today);
  return (
    <Row
      to={`/invoices/${p.invoice_id}`}
      avatar={<Avatar name={p.vendor_name} />}
      title={p.vendor_name}
      sub={p.hold_reason ?? `${when} · ${METHOD[p.method] ?? p.method}`}
      end={<>
        <span className="row-amount"><Money cents={p.amount_cents} currency={p.currency} /></span>
        {/* A status only where it changes what you'd do: held, waiting for release, uncashed, stopped. */}
        {["held", "prepared", "outstanding", "cancelled"].includes(p.status) && <StatusPill kind="payment" status={p.status} />}
      </>}
    />
  );
}
