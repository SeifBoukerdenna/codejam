// Screenshots of the main screens at the two sizes we design for: a 1280×720 projector and a 390px phone.
//   SHOTS=docs/screenshots/after node e2e/screens.mjs
import { launch } from "./cdp.mjs";

const harlow = await (await fetch("http://localhost:8000/api/invoices?status=on_hold", { headers: { "X-User-Id": "U004" } })).json();
const invoice = harlow.find((i) => i.vendor_invoice_number === "HA26-2766")?.invoice_id ?? "AP-00450";
const PAGES = [["home", "/"], ["inbox", "/inbox"], ["invoice", `/invoices/${invoice}`], ["payments", "/payments"],
  ["bank", "/bank"], ["fool", "/fool"]];

for (const [size, opts] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
  const b = await launch(opts);
  try {
    await b.go("/?as=U004");
    for (const [name, path] of PAGES) {
      await b.go(path);
      await b.sleep(400);
      await b.shot(`${name}-${size}`, false);
    }
    if (b.errors.length) console.log(size, "page errors:", b.errors);
  } finally { b.close(); }
}
console.log("saved to", process.env.SHOTS ?? "e2e/out");
