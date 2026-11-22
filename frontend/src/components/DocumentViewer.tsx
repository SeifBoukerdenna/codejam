import { FileSearchOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import type { FieldSource } from "../api";

// The real document, page 1, with a box around every value we read from it (extraction/sources.py stores
// where each one was found). Hovering a field on the right lights up its box here, and the other way round,
// so a reviewer checks "is this the number on the paper?" with their eyes, not by trusting us.

const ZOOMS = [1, 1.5, 2, 3];

export default function DocumentViewer({ documentId, filename, sources, active, onActive, labelOf }: {
  documentId: number;
  filename: string;
  sources: FieldSource[];
  active: string | null;
  onActive: (field: string | null) => void;
  labelOf: (field: string) => string;
}) {
  const [zoom, setZoom] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const boxes = useRef<Record<string, HTMLButtonElement | null>>({});

  // When a field is picked on the right while zoomed in, bring its box into view.
  useEffect(() => {
    if (active && zoom > 0) boxes.current[active]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active, zoom]);

  return (
    <div className="doc">
      <div className="doc-bar">
        <span className="doc-name" title={filename}>{filename}</span>
        <div className="doc-tools">
          <button className="icon-button" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => z - 1)}><MinusOutlined /></button>
          <span className="small num doc-zoom" aria-live="polite">{ZOOMS[zoom] * 100}%</span>
          <button className="icon-button" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)}><PlusOutlined /></button>
          <a className="link-button" href={`/api/documents/${documentId}/file`} target="_blank" rel="noreferrer">
            <FileSearchOutlined aria-hidden /> Original
          </a>
        </div>
      </div>
      <div className="doc-scroll">
        {/* Runtime width: the zoom level. Boxes are % of the page, so they follow at any size. */}
        <div className="doc-page" style={{ width: `${ZOOMS[zoom] * 100}%` }}>
          <img src={`/api/documents/${documentId}/page.png`} alt={`Page 1 of ${filename}`} onLoad={() => setLoaded(true)} />
          {!loaded && <div className="skeleton doc-skeleton" aria-hidden />}
          {loaded && sources.map((s) => (
            <button key={s.field} ref={(el) => { boxes.current[s.field] = el; }}
              className={`doc-box ${active === s.field ? "active" : ""} ${s.source === "ocr" ? "ocr" : ""}`}
              style={{ left: `${s.x0 * 100}%`, top: `${s.y0 * 100}%`, width: `${(s.x1 - s.x0) * 100}%`, height: `${(s.y1 - s.y0) * 100}%` }}
              aria-label={`${labelOf(s.field)}, where it was read on the page`}
              onMouseEnter={() => onActive(s.field)} onMouseLeave={() => onActive(null)}
              onFocus={() => onActive(s.field)} onBlur={() => onActive(null)}
              onClick={() => document.getElementById(`field-${s.field}`)?.scrollIntoView({ block: "center", behavior: "smooth" })} />
          ))}
        </div>
      </div>
    </div>
  );
}
