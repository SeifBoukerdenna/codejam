// Every page at the projector size (1280×720 at 125% zoom = 1024×576) and on a 390px phone:
// no sideways scrolling, no clipped table, no page errors.
import { launch } from "./cdp.mjs";
const PAGES = ["/", "/inbox", "/inbox?tab=hold", "/approvals", "/payments", "/payments?tab=settled", "/bank", "/vendors",
  "/activity", "/activity?tab=tax", "/activity?tab=log", "/fool", "/invoices/AP-00473", "/vendors/V004"];
let problems = 0;
for (const [name, opts] of [["projector", { width: 1024, height: 576 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
  const b = await launch(opts);
  try {
    await b.go("/?as=U003");
    for (const p of PAGES) {
      await b.go(p);
      const r = await b.evaluate(`(() => ({
        page: document.documentElement.scrollWidth > innerWidth + 1,
        tables: [...document.querySelectorAll('.dt-wrap')].filter((w) => w.scrollWidth > w.clientWidth + 1).length,
        smallText: [...document.querySelectorAll('.main p, .main td, .row-title, .check-text')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 15).length,
      }))()`);
      if (r.page || r.tables) { problems++; console.log(name, p, r); }
    }
    if (b.errors.length) { problems++; console.log(name, "page errors:", b.errors.slice(0, 3)); }
  } finally { b.close(); }
}
console.log(problems ? `${problems} problems` : "no overflow, no page errors");
