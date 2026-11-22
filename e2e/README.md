# e2e

`cdp.mjs` drives the real app in headless Chrome through the DevTools protocol: real clicks on visible text,
typing, screenshots, page errors. No dependencies: Node 22+ and Google Chrome.

```js
import { launch } from "./cdp.mjs";
const b = await launch({ width: 1280, height: 720 });
await b.go("/inbox?as=U004");
await b.click("Sort 59 new emails");
await b.shot("inbox");          // → e2e/out/inbox.png
b.close();
```

## The demo, as a test

`make demo-test` runs `demo.mjs`: reseed, then the 3:30 demo click by click (Home, sort the inbox, Harlow and Stern
on hold, Queen Street approved by Priya then Elise via Cmd+K, Elise refused the release (P11), the single-use card
declined / paid / declined, Bank, Paid twice, two "Try to fool us" tricks, System health). Each step is checked on
screen and through the API; it prints PASS/FAIL per step and exits non-zero on any failure or page error. ~45 s.
It reseeds again at the end, so the app is back at the demo's starting point.

`make demo-video` runs the same steps at human pace, with a visible cursor and a caption per step, and records
`docs/demo-run.webm` (Chrome's screencast frames, encoded by ffmpeg). ~4 min. Needs `ffmpeg` with libvpx-vp9.

Other scripts: `screens.mjs` (screenshots at 1280×720 and 390px), `overflow.mjs` (layout check at 1024×576 and 390px).
