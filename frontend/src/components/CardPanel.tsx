import { Button, Input } from "antd";
import { useState } from "react";
import { send, type CardAttempt, type Permission, type VirtualCard } from "../api";
import { ago, money } from "../format";
import { useRunner } from "./actions";
import { CardFace, Check, Panel } from "./ui";

/** The single-use card of a card payment, a way to play the vendor charging it, and every attempt with the
 *  card's answer. There's no real card network, so "charge" stands in for the vendor's terminal. */
export default function CardPanel({ card, attempts, permission, onChanged }: {
  card: VirtualCard; attempts: CardAttempt[]; permission?: Permission | null; onChanged: () => void;
}) {
  const run = useRunner();
  const [merchant, setMerchant] = useState(card.vendor_name.toUpperCase());
  const [amount, setAmount] = useState((card.limit_cents / 100).toFixed(2));
  const [year, month] = card.expires_on.split("-");
  const expires = `${month}/${year.slice(2)}`;

  return (
    <Panel title="Virtual card">
      <CardFace last4={card.last4} expires={expires} amount={money(card.limit_cents, card.currency)}
        lockedTo={card.vendor_name} status={card.status} />
      <div className="small muted mt-3">
        {card.status === "active" ? `Sent to ${card.sent_to}. Waiting for their charge.`
          : card.status === "used" ? "Charged once, then closed for good." : "Cancelled with its payment."}
      </div>

      {permission && (
        <div className="charge-form">
          <div className="strong">Charge it like the vendor would</div>
          <label>Merchant name<Input value={merchant} onChange={(e) => setMerchant(e.target.value)} /></label>
          <label>Amount<Input prefix="$" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <Button type={card.status === "active" ? "primary" : "default"} className={card.status === "active" ? undefined : "soft"}
            shape="round" size="large" disabled={!permission.allowed}
            onClick={() => run(() => send<CardAttempt>("POST", `/virtual-cards/${card.card_id}/charges`, { merchant, amount }).then((a) => {
              if (!a.approved) throw new Error(a.reason);
            }), "Charge approved. The invoice is paid.", onChanged)}>
            Charge the card
          </Button>
          {!permission.allowed && <div className="reason">{permission.reason}</div>}
        </div>
      )}

      {attempts.length > 0 && (
        <div className="checks mt-3">
          {attempts.map((a) => (
            <Check key={a.auth_id} tone={a.approved ? "positive" : "negative"}
              meta={`${a.merchant} · ${money(a.amount_cents, card.currency)} · ${ago(a.attempted_at)}`}>
              {a.reason}
            </Check>
          ))}
        </div>
      )}
    </Panel>
  );
}
