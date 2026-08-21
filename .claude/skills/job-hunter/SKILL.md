---
name: job-hunter
description: Working reference for job-hunter (C:\workspace\job-hunter), a personal Chrome extension (Manifest V3, no backend) that assists with job applications - a local, offline, regex/alias-based "category matcher" recognizes common form fields (name, email, LinkedIn, resume, salary, phone, etc.) on any ATS site and fills them instantly with zero AI/network calls, using a shipped English+Portuguese alias dictionary the user can extend via an in-page modal or the options page. Claude is only ever involved for things that are genuine, permanent technical constraints - file attachments (browsers block scripts from assigning `.files`), cover-letter drafting, and email/LinkedIn-DM sending - via a `pendingActions` queue Claude resolves by driving the user's real Chrome. Use this whenever the user is working on job-hunter - the extension's content scripts/background worker, the category-matching dictionary, the pending-actions/agent-bridge hand-off, or the options page. For LinkedIn's own URL patterns and general browser-automation gotchas (reusable outside this project), see the linkedin-automation skill instead.
---

# job-hunter

A personal, single-user Chrome extension living entirely at `C:\workspace\job-hunter\extension\` (Manifest V3, plain classic scripts, no build step, no bundler). **There is no backend of any kind** — an earlier Spring Boot/Playwright design was fully abandoned mid-project (see `.claude\plans\lets-create-a-plan-snazzy-graham.md` for that discarded plan, and `.claude\plans\partitioned-dancing-dolphin.md` for the two plans that actually got built: the Chrome-extension pivot, then the local category-matching autofill engine). If you see any reference to Java, `org.inclutech.jobhunter`, Playwright, or a Spring Boot app anywhere, it's stale — don't act on it.

**Current version: check `extension/manifest.json`'s `"version"` field directly — it changes on every session.** Convention: bump it on every code change (patch for small edits, minor for architectural ones) so a `chrome://extensions` reload has a visible confirmation it picked up new code. Do this in the same turn as any edit under `extension/`, without being asked.

## Architecture in one paragraph

Everything hangs off a shared `self.JH` namespace (no ES modules — content scripts share one isolated-world global per page, `background.js` uses `importScripts`). `shared/field-categories.js` ships a dictionary (`DEFAULT_CATEGORY_REFS`: category → candidateData path; `DEFAULT_CATEGORY_ALIASES`: category → alternate wordings in English/Portuguese) plus the pure matching engine (`matchCategory`, `normalizeText`, `detectInteractionType`). `content/field-scanner.js` walks the live DOM for fillable elements and builds a text signature per field. `content/autofill-engine.js`'s `runAutoComplete()` ties it together: scan → match → fill matched fields instantly (`shared/selector-fill.js`, always character-by-character typing for text fields — safe for masked inputs, no separate "is this masked" detection needed) → for anything unmatched, show `content/category-modal.js`'s in-page modal (link to an existing category, or define a brand-new one — **never** a Claude hand-off) → file inputs always queue an `attach-file` pending action regardless of category confidence, since browsers permanently block scripts from setting `.files`. Cover-letter drafting (`content/cover-letter.js`) and email/LinkedIn-DM sending (`content/contact-actions.js`) are separate, older features untouched by the category-matching rework — they still queue `pendingActions` for Claude. Claude resolves the queue via `content/agent-bridge.js`, a `window.postMessage` relay reachable from **any** regular page (see Gotchas — this exists because `chrome-extension://` URLs can't be navigated to by browser-automation tools).

## Where things live

```
extension/
├── manifest.json                 # v-bump this every change. commands: Ctrl+Shift+U triggers auto-complete
├── background/background.js      # context menus (email/DM only, NOT auto-complete anymore), IndexedDB, downloads-mirroring, chrome.commands
├── shared/
│   ├── storage-schema.js         # chrome.storage.local keys/helpers, category dictionary merge (getEffectiveCategoryDictionary)
│   ├── field-categories.js       # THE matching engine + shipped dictionary - edit this to add default categories/aliases
│   ├── template-engine.js        # {{placeholder}} substitution for the email/DM message template
│   └── selector-fill.js          # fill primitives: simulateTyping, fillComboSearchSelect, setFieldValue
├── content/
│   ├── field-scanner.js          # scanFormFields() - DOM walk + signature building
│   ├── category-modal.js/.css    # the "unrecognized field" in-page modal
│   ├── agent-bridge.js           # postMessage relay Claude uses to reach storage from any page
│   ├── autofill-engine.js        # runAutoComplete() - the main flow; also owns showToast()
│   ├── cover-letter.js           # per-company cover-letter cache/draft flow (untouched by category-matching rework)
│   ├── contact-actions.js        # email/LinkedIn-DM pending-action queuing (untouched)
│   └── linkedin-highlight.js     # java-keyword highlighting on LinkedIn job search, linkedin.com only
├── options/                      # settings UI: Resume, Cover Letter, Candidate Data, Email/DM Template, Pending, Field Categories tabs
└── seed/                         # bundled defaults: candidate-data.seed.json, message-template.seed.json, resume PDF
```

Candidate data lives in `chrome.storage.local` (`candidateData` key), auto-seeded on install from `seed/candidate-data.seed.json`, edited via the options page's Candidate Data tab — there is no YAML file anymore, that was the old Spring Boot design.

## Currently mid-troubleshooting (read this first in a new session)

**`Ctrl+Shift+U` root cause found, fix not yet confirmed working.** `chrome.commands.getAll()` (logged from a diagnostic added to `background.js`'s command listener, read from the background service-worker console) showed `{name: "auto-complete", shortcut: ""}` — Chrome's internal registry has **no key bound at all**, despite the manifest's `suggested_key` and despite `chrome://extensions/shortcuts` having appeared correctly bound earlier. Chrome silently drops a suggested key it can't assign rather than erroring. This was never a code bug — nothing in `background.js`, `agent-bridge.js`, or the fill engine could have fixed it (all of that was independently verified working end-to-end on a real GeekHunter page on 2026-08-18, via the debug hook below). **The fix is manual**: `chrome://extensions/shortcuts` → find Job Hunter Assistant's row → click into the input (it'll actually be empty) → press the combo directly to bind it (try `Ctrl+Shift+U` first, then `Ctrl+Shift+Y`/`Alt+Shift+U` if Chrome rejects it as taken). If a new session hears "still broken" *after* a rebind was done, re-open `chrome.commands.getAll()` in the service-worker console to check whether it's really non-empty now before assuming the diagnosis was wrong.

Things added this session that outlive this specific bug:
- **`JH.showStatusBanner()`** (`content/autofill-engine.js`) — a small, non-blocking top-right progress pill, visible 15s per update, that updates live through a run ("command received…" → "scanning…" → "filling field N/M…" → summary). Gives the user a console-free way to report whether the command reached the tab at all.
- **`"run-auto-complete"` agent-bridge action** — lets Claude trigger `JH.runAutoComplete()` directly via `postMessage`, bypassing `chrome.commands` entirely. This is now the standard way for Claude to test the fill engine on any page without needing the user's real keyboard — don't say "I can't test this, only you can" for autofill anymore, use this instead.
- **Resume attachment is fully fixed and verified end-to-end** (was silently broken: `resumeMeta.mirroredPath` stuck empty on old-seeded records, *and* the `"reseed-resume"` recovery path was itself broken — a content script can't `fetch()` a bundled extension resource without a `web_accessible_resources` manifest entry, which this deliberately still doesn't have. Fixed by moving the bundled-PDF fetch into `background.js`; see status.md for the full detail). Confirmed working by actually uploading the resume to a live GeekHunter form (2026-08-18) — see the `mcp__claude-in-chrome__file_upload` gotcha below for the one non-obvious step that took.

## Further reading (load only when needed)

- `references/extension-structure.md` — full file-by-file map with responsibilities, storage schema, and the category-matching data flow in detail.
- `references/gotchas.md` — every real, hard-won gotcha from building this: automation-tool limits (no chrome:// / chrome-extension:// navigation, no native context menu/toolbar interaction, no bare-F-key shortcuts), the isolated-world vs main-world distinction that shapes the whole agent-bridge design, the salary-field masking bug and its fix, the `chrome.downloads` race condition, real ATS DOM quirks (GrupoBolt/InHire, GeekHunter).
- `references/status.md` — what's built vs. still open, and the current mid-session bug above in more detail.
- `references/running-tests.md` — how to reload the extension and manually verify a change (there's no automated test suite — this is "how a human/Claude actually checks it works").
