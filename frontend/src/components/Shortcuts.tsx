import { Modal } from "antd";
import { useEffect, useRef } from "react";
import { Kbd } from "./ui";

/** Single-key shortcuts for a page. Ignored while typing in a field, while a dialog is open, or with Cmd/Ctrl
 *  held (those belong to the browser and to Cmd+K). */
export function useShortcuts(map: Record<string, () => void>, enabled = true) {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      // Dialogs keep focus inside themselves, so a key pressed while one is open has its target in there.
      if (t.closest("input, textarea, select, [contenteditable=true], .ant-select, .ant-modal, .ant-drawer")) return;
      const action = latest.current[e.key];
      if (action) { e.preventDefault(); action(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export function ShortcutsHelp({ open, onClose, items }: { open: boolean; onClose: () => void; items: [string, string][] }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Keyboard shortcuts" width={420}>
      <div className="shortcut-list">
        {items.map(([key, what]) => (
          <div key={key} className="spread"><span>{what}</span><Kbd>{key}</Kbd></div>
        ))}
      </div>
    </Modal>
  );
}
