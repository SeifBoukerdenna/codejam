import { App, Input, Modal } from "antd";
import { useState } from "react";

/** Fired after any successful action, so the sidebar's work counts update without a page change. */
export const CHANGED = "harborline:changed";

/** Run an action against the API: success toast, or the server's own reason when it refuses
 *  ("You approved this invoice, so you can't release its payment (P11)"). Always refreshes after. */
export function useRunner() {
  const { message } = App.useApp();
  return async (action: () => Promise<unknown>, success: string, refresh?: () => void): Promise<boolean> => {
    try {
      await action();
      message.success(success);
      window.dispatchEvent(new Event(CHANGED));
      return true;
    } catch (e) {
      message.error({ content: (e as Error).message, duration: 6 });
      return false;
    } finally {
      refresh?.();
    }
  };
}

/** Asks "why?" before anything that stops or refuses money: the reason goes into the audit log. */
export function ReasonModal(props: {
  open: boolean;
  title: string;
  okText: string;
  placeholder?: string;
  onSubmit: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={props.open}
      title={props.title}
      okText={props.okText}
      okButtonProps={{ danger: true, disabled: !reason.trim(), loading: busy, shape: "round" }}
      cancelButtonProps={{ shape: "round" }}
      onCancel={props.onClose}
      onOk={async () => {
        setBusy(true);
        await props.onSubmit(reason.trim());
        setBusy(false);
        setReason("");
        props.onClose();
      }}
      destroyOnHidden
    >
      <p className="muted">This reason is saved in the audit log.</p>
      <Input.TextArea autoFocus rows={3} value={reason} placeholder={props.placeholder}
        onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}
