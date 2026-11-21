// A small Chrome DevTools Protocol driver: real mouse clicks on visible text, typing into labelled inputs,
// screenshots, and every page error captured. No dependencies (Node's built-in fetch + WebSocket).
// DECISION: our own ~100 lines instead of Playwright: nothing to install, works offline, and the team can read
// every line of it. Rejected: Playwright (a large dev dependency plus a browser download).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SHOTS ?? "e2e/out";
const PROFILE = process.env.CHROME_PROFILE ?? "e2e/.chrome-profile";
const PORT = 9341;
export const BASE = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1440, height = 1000, mobile = false } = {}) {
  mkdirSync(SHOTS, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--disable-gpu", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, what, ms = 15000) => {
    for (let t = 0; t < ms; t += 150) {
      if (await evaluate(expr).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  // Find the innermost visible element whose text matches, then click its centre with a real mouse event.
  const locate = (text, within = "body") => `(() => {
    const want = ${JSON.stringify(text)};
    const root = document.querySelector(${JSON.stringify(within)}) || document.body;
    const all = [...root.querySelectorAll("button, a, [role=tab], .row, .chip, label, span, div")];
    const hits = all.filter((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden")) return false;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      return (el.innerText && el.innerText.trim() === want) || own === want;
    });
    const el = hits.find((h) => h.matches("button, a, [role=tab]")) || hits.at(-1);
    if (!el) return null;
    const target = el.closest("button, a, [role=tab]") || el;
    target.scrollIntoView({ block: "center" });
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!target.disabled };
  })()`;
  const click = async (text, { within, wait = 400 } = {}) => {
    let pos;
    for (let t = 0; t < 8000 && !pos; t += 150) { pos = await evaluate(locate(text, within)); if (!pos) await sleep(150); }
    if (!pos) throw new Error(`no visible element with text "${text}"`);
    if (pos.disabled) throw new Error(`"${text}" is disabled`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await sleep(wait);
  };
  // Type into the input inside the <label> whose text starts with `label` (React needs the native setter + input event).
  const fill = async (label, value) => {
    const ok = await evaluate(`(() => {
      const lab = [...document.querySelectorAll("label")].find((l) => l.innerText.trim().startsWith(${JSON.stringify(label)}));
      const input = lab && lab.querySelector("input");
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`no input labelled "${label}"`);
    await sleep(200);
  };
  const go = async (path) => {
    await send("Page.navigate", { url: BASE + path });
    await waitFor("document.readyState === 'complete' && !document.body.innerText.includes('Loading…')", `load ${path}`);
    await sleep(500);
  };
  const shot = async (name, full = true) => {
    await sleep(250);
    const m = await send("Page.getLayoutMetrics");
    const h = Math.ceil(full ? m.cssContentSize.height : height);
    const top = full ? 0 : await evaluate("window.scrollY");
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full,
      clip: { x: 0, y: top, width, height: Math.min(h, 6000), scale: 1 } });
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
  };
  const text = () => evaluate("document.body.innerText");
  const close = () => { ws.close(); chrome.kill(); };
  return { send, evaluate, waitFor, click, fill, go, shot, text, errors, close, sleep };
}
