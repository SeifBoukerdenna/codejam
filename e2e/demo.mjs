// The 3:30 demo, as a test. Every step is a real click in Chrome, checked against the screen and the API.
//
//   node e2e/demo.mjs                                  test: reseed, click through, assert, print PASS/FAIL per step
//   RECORD=docs/demo-run.webm node e2e/demo.mjs        same steps at human pace, with a visible cursor and captions,
//                                                      recorded from Chrome's screencast and encoded by ffmpeg
// `make demo-test` / `make demo-video` run these, then reseed so the app is back at the demo's starting point.
//
// DECISION: the backup video is produced by the same script as the test, so the video can't show a demo that the
// test says is broken. Rejected: a screen recording made by hand (goes stale after every change).
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launch } from "./cdp.mjs";

const API = "http://localhost:8000/api";
const RECORD = process.env.RECORD;
const PACE = RECORD ? 1 : 0.15;                      // human pace when recording, quick when testing
const pause = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const api = async (path, user = "U004") => (await fetch(`${API}${path}`, { headers: { "X-User-Id": user } })).json();

console.log("reseeding…");
execSync("make reseed", { stdio: "ignore" });

const b = await launch({ width: 1280, height: 720 });
let passed = 0, failed = 0;
const step = async (name, fn) => {
  try { await fn(); passed++; console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "→", e.message); await b.shot(`demo-fail-${passed + failed}`, false); }
};
const must = (cond, what) => { if (!cond) throw new Error(what); };
// Numbers arrive with their own request after the page loads: wait for them, and look only in the app (not captions).
const shows = (text) => b.waitFor(`document.querySelector("main")?.innerText.includes(${JSON.stringify(text)})`, `"${text}" on screen`, 10000);
const key = async (k, code, vk, modifiers = 0) => {
  for (const type of ["keyDown", "keyUp"]) await b.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const type = async (text) => {
  for (const ch of text) { await b.send("Input.insertText", { text: ch }); await pause(70); }
};

// ── What only the video needs: a cursor you can follow and a caption saying what's happening ──
const OVERLAY = `(() => {
  const install = () => {
    if (!document.body || document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = "#demo-cursor{position:fixed;z-index:99999;width:20px;height:20px;border-radius:50%;background:rgba(17,17,17,.5);"
      + "border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;transform:translate(-50%,-50%);"
      + "transition:left .5s ease,top .5s ease,background .15s}#demo-cursor.down{background:rgba(255,190,0,.95)}"
      + "#demo-caption{position:fixed;z-index:99998;left:50%;bottom:24px;transform:translateX(-50%);max-width:900px;padding:12px 22px;"
      + "border-radius:14px;background:rgba(17,17,17,.9);color:#fff;font:600 17px/1.45 'Inter Tight',system-ui,sans-serif;"
      + "text-align:center;pointer-events:none}#demo-caption:empty{display:none}";
    document.head.appendChild(style);
    const cursor = document.createElement("div"); cursor.id = "demo-cursor";
    const [x, y] = JSON.parse(sessionStorage.getItem("demo-cursor") || "[640,360]");
    cursor.style.left = x + "px"; cursor.style.top = y + "px";
    const caption = document.createElement("div"); caption.id = "demo-caption";
    caption.textContent = sessionStorage.getItem("demo-caption") || "";
    document.body.append(cursor, caption);
  };
  window.__demo = {
    move(x, y) { sessionStorage.setItem("demo-cursor", JSON.stringify([x, y])); install();
      const c = document.getElementById("demo-cursor"); c.style.left = x + "px"; c.style.top = y + "px"; },
    tap() { install(); const c = document.getElementById("demo-cursor"); c.classList.add("down"); setTimeout(() => c.classList.remove("down"), 260); },
    caption(t) { sessionStorage.setItem("demo-caption", t); install(); document.getElementById("demo-caption").textContent = t; },
  };
  document.addEventListener("DOMContentLoaded", install);
  install();
})()`;
// Long enough to read: about a quarter of a second per word, never under 1.5 s.
const say = async (text) => {
  if (!RECORD) return;
  await b.evaluate(`__demo.caption(${JSON.stringify(text)})`);
  await pause(Math.max(1500, text.split(" ").length * 260));
};
const glide = async (x, y) => {
  await b.evaluate(`__demo.move(${x}, ${y})`);
  await pause(600);
};
if (RECORD) {
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY });
  b.hooks.point = async (x, y) => { await glide(x, y); await b.evaluate("__demo.tap()"); };
}
// Hover (or click) the element a JS expression finds, the way a person would: the cursor goes there first.
const centre = async (expr) => {
  await b.evaluate(`(${expr}).scrollIntoView({ block: "center" })`);
  await b.sleep(150);
  return b.evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
};
const hover = async (expr, ms = 2200) => {
  const [x, y] = await centre(expr);
  if (RECORD) await glide(x, y);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await pause(ms);
};
const clickAt = async (expr) => {
  const [x, y] = await centre(expr);
  if (RECORD) { await glide(x, y); await b.evaluate("__demo.tap()"); }
  for (const t of ["mouseMoved", "mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type: t, x, y, button: "left", clickCount: 1 });
  await pause(1200); await b.sleep(400);
};
const nav = (href) => clickAt(`document.querySelector('.side-nav a[href="${href}"]')`);
// Cmd+K, type, Enter: how the demo finds an invoice or switches who you are.
const palette = async (text, expect) => {
  await key("k", "KeyK", 75, 4); await pause(500);
  await type(text);
  await b.waitFor(`[...document.querySelectorAll(".palette-item")].some((i) => i.innerText.includes(${JSON.stringify(expect)}))`, `palette shows ${expect}`);
  await pause(900);
  await key("Enter", "Enter", 13); await b.sleep(700); await pause(900);
};
const me = () => b.evaluate("document.querySelector('.side-user .user-pill-name')?.innerText");
const become = async (who, name) => {
  await palette(`as ${who}`, name);
  must((await me()) === name, `expected to be ${name}, am ${await me()}`);
};

// ── Recording: Chrome sends a frame whenever the screen changes; each is kept with its timestamp ──
const frames = [];
const frameDir = resolve("e2e/out/frames");
if (RECORD) {
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  b.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = `${frameDir}/${String(frames.length).padStart(6, "0")}.jpg`;
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: metadata.timestamp });
    b.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
}

try {
  await b.go("/?as=U004");
  if (RECORD) await b.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1280, maxHeight: 720 });

  await step("1. Home: $23,601.92 paid twice and $1,523.09 the bank can't explain", async () => {
    await say("Jordan, an AP clerk at Harborline Logistics, starts the day on Home.");
    await shows("$23,601.92"); await shows("$1,523.09");
    await say("Every amount shows its math on hover, computed by the server, never by the browser.");
    await hover("[...document.querySelectorAll('.row')].find((r) => /Paid twice/.test(r.innerText)).querySelector('.money')", 3000);
  });

  await step("2. Inbox: 59 emails sorted, every invoice read by the worker", async () => {
    await nav("/inbox");
    await say("59 emails arrived. Newsletters, statements and payment questions don't become invoices.");
    await b.click("Sort 59 new emails", { wait: 800 });
    await say("The worker reads each invoice: the PDF's own text, or 3 OCR passes for a scan. No AI model.");
    for (let i = 0; i < 120 && (await api("/invoices?status=extracting")).length; i++) await b.sleep(1000);
    const emails = await api("/emails");
    must(emails.every((e) => e.intake_status !== "unprocessed"), "emails left unsorted");
    must((await api("/invoices?status=extracting")).length === 0, "worker still reading");
    await pause(1500);
  });

  await step("3. Harlow and Stern: on hold, the document beside what we read, the look-alike named", async () => {
    await b.go("/inbox?tab=hold");
    await say("On hold: “Harlow and Stern LLP”, a look-alike of the law firm we actually pay.");
    await b.click("Harlow and Stern LLP", { wait: 1200 });
    await b.waitFor("document.querySelectorAll('.doc-box').length > 5", "boxes on the document");
    const blocked = await b.evaluate("document.querySelector('.pipeline-step.blocked')?.innerText ?? ''");
    must(/looks like/.test(blocked), `blocked step says: ${blocked}`);
    await say("Left: the real document. Each value we read has a box. Point at the bank account…");
    await hover("document.getElementById('field-bank_account')", 2500);
    must(await b.evaluate("!!document.querySelector('.doc-box.active')"), "no box lit on the document");
  });

  const qs = (await api("/invoices?status=pending_approval")).find((i) => i.vendor_invoice_number === "002935")?.invoice_id;
  await step(`4. Queen Street rent (${qs}): Priya, then Elise approve, switching user with Cmd+K`, async () => {
    must(qs, "Queen Street 002935 isn't waiting for approval");
    await palette("002935", "Queen Street");
    await say("Queen Street rent, $18,758. Liam is on leave, and his delegate can't fill two steps, so step 1 goes to his manager.");
    await say("Cmd+K switches who we are: Priya approves step 1…");
    await become("priya", "Priya Raman");
    await b.click("Approve $18,758.00 CAD", { wait: 1200 });
    await say("…and Elise, the finance manager, approves step 2.");
    await become("elise", "Elise Tremblay");
    await b.click("Approve $18,758.00 CAD", { wait: 1200 });
    must((await api(`/invoices/${qs}`)).invoice.status === "approved", "not approved");
  });

  await step("5. Jordan prepares the payment; Elise can't release it (P11)", async () => {
    await say("Jordan prepares the payment. AP clerks prepare payments; they can't release them.");
    await become("jordan", "Jordan Okafor");
    await b.click("Pay $18,758.00 CAD", { wait: 1200 });
    await say("Now Elise. She approved this invoice, so the server refuses to let her release its payment.");
    await become("elise", "Elise Tremblay");
    const disabled = await b.evaluate("[...document.querySelectorAll('button')].find((x) => x.innerText.startsWith('Release'))?.disabled");
    must(disabled === true, "Release missing or enabled for Elise");
    await shows("separation of duties");
    await hover("[...document.querySelectorAll('button')].find((x) => x.innerText.startsWith('Release'))", 2500);
  });

  await step("6. Virtual card on AP-00425: declined, paid, then declined as single-use", async () => {
    await say("Next, Northbound is paid by Brim single-use card: locked to the vendor and the exact amount.");
    await become("jordan", "Jordan Okafor");
    await palette("AP-00425", "Northbound");
    await b.click("Virtual card", { wait: 400 });
    await b.click("Pay $3,716.34 CAD", { wait: 1200 });
    await say("Elise didn't approve this one, so she may release it.");
    await become("elise", "Elise Tremblay");
    await b.click("Release $3,716.34 CAD", { wait: 1200 });
    await become("jordan", "Jordan Okafor");
    await say("The vendor charges more than approved: declined, with the reason.");
    await b.fill("Amount", "3800.00"); await b.click("Charge the card", { wait: 1500 });
    await say("The exact amount: approved, and the invoice is paid.");
    await b.fill("Amount", "3716.34"); await b.click("Charge the card", { wait: 1500 });
    await say("Charged again: declined. A single-use card works once.");
    await b.click("Charge the card", { wait: 1500 });
    const d = await api("/invoices/AP-00425");
    must(JSON.stringify(d.card_attempts.map((a) => a.approved).reverse()) === "[false,true,false]", "card answers");
    must(d.invoice.status === "paid", `invoice is ${d.invoice.status}`);
  });

  await step("7. Bank: $1,523.09 of debits nobody can explain", async () => {
    await nav("/bank");
    await say("The bank statement, matched line by line: wire fees we never caused, debits nobody set up, an altered cheque.");
    await shows("$1,523.09");
    await hover("document.querySelector('.hero-value .money')", 3000);
  });

  await step("8. Activity: $23,601.92 paid twice this year", async () => {
    await nav("/activity");
    await say("Paid twice this year: $23,601.92 to get back, vendor by vendor, with a letter ready for each.");
    await shows("$23,601.92");
    await hover("document.querySelector('.hero-value .money')", 2500);
  });

  await step("9. Try to fool us: two forged invoices, both caught", async () => {
    await nav("/fool");
    await say("Try to fool us: a judge forges an invoice, and the normal checks catch it.");
    for (let n = 0; n < 2; n++) {
      await b.click("Try it", { wait: 500 });
      await b.waitFor("![...document.querySelectorAll('button')].some((x) => x.innerText.includes('Reading it'))", "trick read", 30000);
      await pause(2500);
    }
    const page = await api("/fool");
    const done = page.attempts.filter((a) => a.result !== "reading");
    must(done.length >= 2 && done.every((a) => a.result === "caught"), `results: ${done.map((a) => a.result).join(", ")}`);
  });

  await step("10. System health: 3 of 3 promises kept, the audit log verifies", async () => {
    await say("For Marcus, the controller: the worker's speed objectives, and the signed audit log, verified event by event.");
    await become("marcus", "Marcus Webb");
    await nav("/health");
    await shows("3 of 3");
    const chain = await api("/audit/verify", "U002");
    must(chain.ok, chain.reason);
    await pause(2500);
    await say("Every step you saw is in the signed audit log: who did it, on whose behalf, and why.");
    await pause(1500);
  });
} finally {
  if (RECORD) await b.send("Page.stopScreencast").catch(() => {});
  if (b.errors.length) console.log("page errors:", b.errors.join(" | "));
  b.close();
}

if (RECORD && frames.length) {
  // Frames arrive only when the screen changes, so each one is shown until the next: ffmpeg's concat list with durations.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, (frames[i + 1]?.at ?? f.at + 2) - f.at).toFixed(3)}`);
  writeFileSync(`${frameDir}/list.txt`, `${list.join("\n")}\nfile '${frames.at(-1).file}'\n`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${frameDir}/list.txt`,
    "-vf", "fps=25,scale=1280:720,format=yuv420p", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-row-mt", "1",
    "-deadline", "good", "-cpu-used", "4", RECORD]);
  console.log(`recorded ${frames.length} frames → ${RECORD}`);
}
console.log(`${passed}/${passed + failed} steps passed${b.errors.length ? `, ${b.errors.length} page errors` : ", no page errors"}`);
process.exit(failed || b.errors.length ? 1 : 0);
