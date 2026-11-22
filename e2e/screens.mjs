// Screenshots of the main screens at the two sizes we design for: a 1280×720 projector and a 390px phone.
//   SHOTS=docs/screenshots/after node e2e/screens.mjs
import { launch } from "./cdp.mjs";

// Invoice ids depend on the order the worker read the inbox, so look them up by the vendor's invoice number.
const queue = await (await fetch("http://localhost:8000/api/invoices?status=on_hold,needs_review", { headers: { "X-User-Id": "U004" } })).json();
const find = (number, fallback) => queue.find((i) => i.vendor_invoice_number === number)?.invoice_id ?? fallback;
const harlow = find("HA26-2766", "AP-00450");   // a look-alike vendor: blocked
const prairie = find("PR26-1012", "AP-00437");  // a scan where the OCR passes disagree on the transit number
const PAGES = [["home", "/"], ["inbox", "/inbox"], ["invoice", `/invoices/${harlow}`], ["invoice-scan", `/invoices/${prairie}`],
  ["payments", "/payments"], ["bank", "/bank"], ["fool", "/fool"]];

for (const [size, opts] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
  const b = await launch(opts);
  try {
    await b.go("/?as=U004");
    for (const [name, path] of PAGES) {
      await b.go(path);
      await b.sleep(name.startsWith("invoice") ? 1200 : 400);   // the page image loads after the data
      await b.shot(`${name}-${size}`, false);
    }
    // The scan again, scrolled to the disputed transit number with its box lit on the document.
    await b.go(`/invoices/${prairie}`);
    await b.sleep(1200);
    await b.evaluate("document.getElementById('field-bank_transit').scrollIntoView({ block: 'center' })");
    const [x, y] = await b.evaluate("(() => { const r = document.getElementById('field-bank_transit').getBoundingClientRect(); return [r.x + 40, r.y + 20]; })()");
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });   // hover, as a reviewer would
    await b.shot(`invoice-scan-readings-${size}`, false);
    if (b.errors.length) console.log(size, "page errors:", b.errors);
  } finally { b.close(); }
}
console.log("saved to", process.env.SHOTS ?? "e2e/out");
