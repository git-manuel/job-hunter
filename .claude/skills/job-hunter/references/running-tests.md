# Testing the extension (there is no automated test suite)

This is a plain unpacked Manifest V3 extension — verification is manual reload + live interaction, by the user in their real Chrome, or by Claude driving a separate `mcp__claude-in-chrome__*` tab group. **They are not the same browser session** — Claude's automated tab group and the user's own Chrome windows can end up in different states; don't assume something Claude verified in its own tab group is also true in the user's window, and vice versa.

## Reloading after a code change

1. Bump `extension/manifest.json`'s `"version"` (see SKILL.md's convention — do this in the same turn as any code edit).
2. `node --check <file>` on every changed `.js` file, and `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"` after any manifest edit — catches syntax errors and invalid JSON before asking the user to reload, since a broken reload wastes their turn.
3. Ask the user to reload in `chrome://extensions` (Claude cannot do this itself — that page is unreachable to browser-automation tools, see gotchas.md).
4. A tab that was already open *before* the reload has no content script until it's refreshed — always ask "did you refresh the page too, not just reload the extension" if something that depends on content scripts appears broken.

## What Claude can verify itself (via mcp__claude-in-chrome__*)

- Navigate to any ordinary `http(s)://` page and run `field-categories.js`/`storage-schema.js` functions directly via `javascript_tool` **only if** those functions are reached indirectly — direct `JH.foo()` calls from `javascript_tool` will fail with `JH is undefined`, because that executes in the page's main world, not the content scripts' isolated world (see gotchas.md). The one channel that actually works: a `window.postMessage` round-trip through `agent-bridge.js`, e.g.:
  ```js
  await new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const handler = (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.channel !== 'job-hunter-agent-bridge' || d.direction !== 'response' || d.requestId !== requestId) return;
      window.removeEventListener('message', handler);
      resolve(d);
    };
    window.addEventListener('message', handler);
    setTimeout(() => resolve({ok:false, error:'timeout'}), 5000);
    window.postMessage({channel:'job-hunter-agent-bridge', direction:'request', requestId, action:'get-state', payload:{}}, window.location.origin);
  });
  ```
  (**Must** include the `await` — an un-awaited async IIFE/Promise returns `{}` when captured by `javascript_tool`, which looks like an empty-but-successful result and can mislead you into thinking something returned nothing rather than that you forgot to await it.)
- Fill a form live and screenshot the result (as was done against the real GrupoBolt/InHire page this session) to visually confirm correct values — this is the most trustworthy verification available, closer to what the user actually experiences than any unit-style check.
- File uploads via `mcp__claude-in-chrome__file_upload`: find the `<input type=file>`'s ref via `find`, pass an absolute Windows path from this session's own filesystem access (e.g. `extension/seed/Manuel_Almeida_Resume.pdf`) — don't wait on `resumeMeta.mirroredPath` if it's known-empty, use a real file Claude can already read directly.

## What Claude cannot verify itself — ask the user instead

- The right-click context menu items ("JH - Draft email with resume", "JH - Message with resume") — native UI, unreachable.
- The `Ctrl+Shift+U` keyboard shortcut — see status.md, this is the actively-broken item.
- The toolbar icon click (opens options page).
- Whether a manifest change that loads without a JSON-validity error also loads *cleanly* in Chrome's own manifest validator — `node -e "JSON.parse(...)"` only proves valid JSON, not valid Chrome extension manifest semantics (e.g. the `commands` key-syntax gotcha — see gotchas.md — passed JSON validation twice while still being rejected by Chrome).
