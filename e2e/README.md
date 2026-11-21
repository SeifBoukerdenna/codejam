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
