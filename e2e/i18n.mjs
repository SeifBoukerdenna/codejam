// French check: every covered screen (i18n.tsx COVERED) in French for several roles, at 1280×720 and 390px.
// Fails on any word without a translation, any overflow, or a "|context" marker leaking into English.
//   node e2e/i18n.mjs
import { launch } from "./cdp.mjs";

const PAGES = ["/", "/inbox", "/inbox?tab=hold", "/inbox?tab=answer", "/inbox?tab=emails", "/approvals", "/payments?tab=approved",
  "/payments?tab=prepared", "/payments?tab=held", "/payments?tab=going", "/payments?tab=outstanding", "/payments?tab=settled"];
const USERS = ["U004", "U007", "U003", "U002", "U006", "U013"];
let problems = 0;
const missingAll = new Set();   // each page load starts a fresh list in the browser, so collect after every page
for (const [size, opts] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
  const b = await launch(opts);
  try {
    await b.go("/?as=U004");
    await b.evaluate("localStorage.setItem('harborline:lang', 'fr')");
    for (const user of size === "desktop" ? USERS : ["U004"]) {
      await b.go(`/?as=${user}`);
      for (const p of PAGES) {
        await b.go(p); await b.sleep(500);
        const r = await b.evaluate(`({ missing: window.__i18nMissing ?? [], wide: Math.max(document.documentElement.scrollWidth, innerWidth) > ${opts.width} + 1,
          fr: document.querySelector(".lang-buttons .on")?.innerText })`);
        r.missing.forEach((m) => missingAll.add(m));
        if (r.wide) { problems++; console.log(size, user, p, "overflow"); }
        if (r.fr !== "FR") { problems++; console.log(size, user, p, "French not on"); }
      }
      // The palette is part of the frame: open it, type, and look at its words too.
      await b.go("/");
      await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
      await b.sleep(300);
      for (const q of ["", "as eli", "583", "zzzz"]) {
        await b.evaluate(`(() => { const i = document.querySelector('.palette input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await b.sleep(400);
      }
      (await b.evaluate("window.__i18nMissing ?? []")).forEach((m) => missingAll.add(m));
      await b.press("Escape");
    }
    await b.go("/"); await b.sleep(600); await b.shot(`fr-home-${size}`, false);
    await b.go("/payments?tab=approved"); await b.sleep(900); await b.shot(`fr-payments-${size}`, false);
    // A screen that isn't translated stays English, menu included, and says so.
    await b.go("/invoices/AP-00473"); await b.sleep(900);
    const en = await b.evaluate("({ nav: document.querySelector('.side-nav a')?.innerText, note: document.querySelector('.lang-note')?.innerText ?? null })");
    if (size === "desktop" && (en.nav !== "Home" || !en.note)) { problems++; console.log("uncovered screen isn't English with a note:", en); }
    await b.shot(`fr-uncovered-${size}`, false);
    await b.evaluate("localStorage.setItem('harborline:lang', 'en')");
    for (const p of PAGES) {
      await b.go(p); await b.sleep(300);
      if (await b.evaluate("/\\|(payment|payments|date)\\b/.test(document.body.innerText)")) { problems++; console.log(size, "context marker shown in English on", p); }
    }
    if (b.errors.length) { problems += b.errors.length; console.log(size, "page errors:", b.errors); }
  } finally { b.close(); }
}
if (missingAll.size) { problems += missingAll.size; console.log("missing translations:", [...missingAll]); }
console.log(problems ? `${problems} problem(s)` : "French: every covered screen translated, no overflow, English untouched");
process.exit(problems ? 1 : 0);
