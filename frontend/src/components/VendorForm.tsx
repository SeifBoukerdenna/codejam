import { Button, Drawer, Form, Input, Select, Switch } from "antd";
import { useEffect, useState } from "react";
import { api, send, type Reference, type SimilarVendor } from "../api";
import { useApi } from "../session";
import { useRunner } from "./actions";
import { Notice } from "./ui";

export type VendorDraft = Partial<{
  legal_name: string; category: string; default_gl_account: string; address: string; province_or_state: string;
  country: string; gst_hst_number: string; qst_number: string; ap_contact_email: string; bank_institution: string;
  bank_transit: string; bank_account: string; preferred_payment_method: string; requires_po: boolean;
}>;

/** Onboard a vendor. While you type, the server looks for vendors that could be the same company (same GST,
 *  bank account or email) or an imitation of one (similar name, different details). */
export default function VendorForm(props: {
  open: boolean;
  initial?: VendorDraft;
  fromInvoiceId?: string;
  onClose: () => void;
  onCreated: (vendorId: string) => void;
}) {
  const [form] = Form.useForm<VendorDraft>();
  const { data: ref } = useApi<Reference>(props.open ? "/reference" : null);
  const [similar, setSimilar] = useState<SimilarVendor[]>([]);
  const [busy, setBusy] = useState(false);
  const run = useRunner();
  const name = Form.useWatch("legal_name", form);
  const gst = Form.useWatch("gst_hst_number", form);
  const account = Form.useWatch("bank_account", form);
  const email = Form.useWatch("ap_contact_email", form);

  useEffect(() => {
    if (props.open) form.setFieldsValue({ country: "CA", preferred_payment_method: "EFT", requires_po: false, ...props.initial });
  }, [props.open, props.initial, form]);

  useEffect(() => {
    if (!name || name.length < 3) return setSimilar([]);
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ name, gst: gst ?? "", bank_account: account ?? "", email: email ?? "" });
      api<SimilarVendor[]>(`/vendors/similar?${q}`).then(setSimilar).catch(() => setSimilar([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [name, gst, account, email]);

  const submit = async (values: VendorDraft) => {
    setBusy(true);
    let created = "";
    const ok = await run(async () => {
      const r = await send<{ vendor_id: string }>("POST", "/vendors", { ...values, from_invoice_id: props.fromInvoiceId });
      created = r.vendor_id;
    }, "Vendor added. It stays “pending review” until a finance manager approves it.");
    setBusy(false);
    if (ok) {
      form.resetFields();
      props.onCreated(created);
    }
  };

  return (
    <Drawer open={props.open} onClose={props.onClose} size={560} title={null} destroyOnHidden>
      <h2 className="drawer-title">Add a vendor</h2>
      <p className="muted">New vendors can't be paid until someone else approves them.</p>

      {similar.map((s) => (
        <Notice key={s.vendor_id} tone={s.kind === "lookalike" ? "negative" : "warning"}
          title={s.kind === "duplicate" ? `Looks like ${s.legal_name} (${s.vendor_id}), already in our list`
            : `Very similar to ${s.legal_name} (${s.vendor_id}), but with different details`}>
          {s.reasons.join(", ")}. {s.kind === "duplicate" ? "Use the existing vendor instead of adding it twice."
            : "Could be an impersonation. Check with the real vendor using contact details we already have."}
        </Notice>
      ))}

      <Form form={form} layout="vertical" onFinish={submit} style={{ marginTop: 20 }} requiredMark={false}>
        <Form.Item name="legal_name" label="Legal name" rules={[{ required: true, message: "Required" }]}><Input /></Form.Item>
        <Form.Item name="category" label="Category" rules={[{ required: true, message: "Required" }]}>
          <Select showSearch options={(ref?.categories ?? []).map((c) => ({ value: c, label: c }))} />
        </Form.Item>
        <Form.Item name="default_gl_account" label="Default GL account">
          <Select showSearch optionFilterProp="label" allowClear
            options={(ref?.gl_accounts ?? []).map((g) => ({ value: g.account_number, label: `${g.account_number} ${g.name}` }))} />
        </Form.Item>
        <Form.Item name="ap_contact_email" label="Billing email"><Input /></Form.Item>
        <Form.Item name="address" label="Address"><Input /></Form.Item>
        <div style={{ display: "flex", gap: 12 }}>
          <Form.Item name="province_or_state" label="Province / state" style={{ flex: 1 }}><Input maxLength={2} /></Form.Item>
          <Form.Item name="country" label="Country" style={{ flex: 1 }}>
            <Select options={[{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }]} />
          </Form.Item>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Form.Item name="gst_hst_number" label="GST/HST number" style={{ flex: 1 }}><Input placeholder="123456789RT0001" /></Form.Item>
          <Form.Item name="qst_number" label="QST number" style={{ flex: 1 }}><Input /></Form.Item>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Form.Item name="bank_institution" label="Institution" style={{ width: 110 }}><Input maxLength={3} /></Form.Item>
          <Form.Item name="bank_transit" label="Transit" style={{ width: 130 }}><Input maxLength={5} /></Form.Item>
          <Form.Item name="bank_account" label="Account" style={{ flex: 1 }}><Input /></Form.Item>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Form.Item name="preferred_payment_method" label="Pay by" style={{ flex: 1 }}>
            <Select options={[{ value: "EFT", label: "Bank transfer" }, { value: "CHEQUE", label: "Cheque" }, { value: "CARD", label: "Virtual card" }]} />
          </Form.Item>
          <Form.Item name="requires_po" label="Needs a PO" valuePropName="checked"><Switch /></Form.Item>
        </div>
        <Button type="primary" shape="round" size="large" htmlType="submit" style={{ marginTop: 8 }} loading={busy} block>Add vendor</Button>
      </Form>
    </Drawer>
  );
}
