import { Button, Drawer, Form, Input, Select } from "antd";
import { useEffect } from "react";
import { send, type InvoiceDetail, type Reference } from "../api";
import { PROVINCE } from "../format";
import { useApi } from "../session";
import { useRunner } from "./actions";

const toDollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

/** A person corrects what was read, or recodes lines. Every change is diffed and audited on the server,
 *  then all checks run again. */
export default function InvoiceEditor({ data, open, onClose, onSaved }: {
  data: InvoiceDetail; open: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const { data: ref } = useApi<Reference>(open ? "/reference" : null);
  const run = useRunner();
  const inv = data.invoice;
  const printed = data.extraction?.fields ?? {};

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      vendor_id: inv.vendor_id, vendor_invoice_number: inv.vendor_invoice_number, invoice_date: inv.invoice_date,
      due_date: inv.due_date, ship_to_province: inv.ship_to_province, department_id: inv.department_id,
      requester_user_id: inv.requester_user_id, subtotal_cents: toDollars(inv.subtotal_cents),
      gst_hst_cents: toDollars(inv.gst_hst_cents), pst_qst_cents: toDollars(inv.pst_qst_cents),
      total_cents: toDollars(inv.total_cents), vendor_gst: printed.vendor_gst ?? "",
      bank_institution: printed.bank_institution ?? "", bank_transit: printed.bank_transit ?? "",
      bank_account: printed.bank_account ?? "",
      ...Object.fromEntries(data.lines.map((l) => [`gl_${l.line_no}`, l.gl_account])),
    });
  }, [open, form, inv, printed, data.lines]);

  const save = async (values: Record<string, string>) => {
    const { reason, ...rest } = values;
    const invoiceChanges = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("gl_")));
    const lineChanges = data.lines.filter((l) => values[`gl_${l.line_no}`] !== l.gl_account);
    const ok = await run(async () => {
      await send("PATCH", `/invoices/${inv.invoice_id}`, { ...invoiceChanges, reason });
      for (const l of lineChanges) {
        await send("PATCH", `/invoices/${inv.invoice_id}/lines/${l.line_no}`, { gl_account: values[`gl_${l.line_no}`] });
      }
    }, "Saved. All checks ran again.", onSaved);
    if (ok) onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} size={600} title={null} destroyOnHidden>
      <h2 className="drawer-title">Correct this invoice</h2>
      <p className="muted">Compare with the original document. Every change is recorded with your name.</p>
      <Form form={form} layout="vertical" onFinish={save} requiredMark={false} className="mt-4">
        <Form.Item name="vendor_id" label="Vendor">
          <Select showSearch optionFilterProp="label" allowClear placeholder="Not in our vendor list"
            options={(ref?.vendors ?? []).map((v) => ({ value: v.vendor_id, label: `${v.legal_name} (${v.vendor_id})` }))} />
        </Form.Item>
        <div className="form-row">
          <Form.Item name="vendor_invoice_number" label="Invoice number"><Input /></Form.Item>
          <Form.Item name="invoice_date" label="Invoice date"><Input type="date" /></Form.Item>
          <Form.Item name="due_date" label="Due"><Input type="date" /></Form.Item>
        </div>
        <div className="form-row">
          <Form.Item name="ship_to_province" label="Delivered to">
            <Select options={Object.entries(PROVINCE).map(([code, name]) => ({ value: code, label: name }))} />
          </Form.Item>
          <Form.Item name="department_id" label="Department">
            <Select options={(ref?.departments ?? []).map((d) => ({ value: d.department_id, label: d.name }))} />
          </Form.Item>
        </div>
        <Form.Item name="requester_user_id" label="Requested by">
          <Select showSearch optionFilterProp="label"
            options={(ref?.users ?? []).map((u) => ({ value: u.user_id, label: `${u.full_name} · ${u.title}` }))} />
        </Form.Item>
        <div className="form-row">
          <Form.Item name="subtotal_cents" label="Subtotal"><Input prefix="$" /></Form.Item>
          <Form.Item name="gst_hst_cents" label="GST / HST"><Input prefix="$" /></Form.Item>
          <Form.Item name="pst_qst_cents" label="PST / QST"><Input prefix="$" /></Form.Item>
          <Form.Item name="total_cents" label="Total"><Input prefix="$" /></Form.Item>
        </div>
        <h3 className="subhead">As printed on the invoice</h3>
        <Form.Item name="vendor_gst" label="GST/HST number"><Input /></Form.Item>
        <div className="form-row">
          <Form.Item name="bank_institution" label="Institution" className="field-sm"><Input /></Form.Item>
          <Form.Item name="bank_transit" label="Transit" className="field-md"><Input /></Form.Item>
          <Form.Item name="bank_account" label="Account"><Input /></Form.Item>
        </div>
        <h3 className="subhead">Ledger account per line</h3>
        {data.lines.map((l) => (
          <Form.Item key={l.line_no} name={`gl_${l.line_no}`} label={l.description} extra={l.coding_reason}>
            <Select showSearch optionFilterProp="label"
              options={(ref?.gl_accounts ?? []).map((g) => ({ value: g.account_number, label: `${g.account_number} ${g.name}` }))} />
          </Form.Item>
        ))}
        <Form.Item name="reason" label="Why (optional)"><Input placeholder="e.g. Corrected the transit from the original scan" /></Form.Item>
        <Button type="primary" shape="round" size="large" htmlType="submit" className="mt-2" block>Save and re-check</Button>
      </Form>
    </Drawer>
  );
}
