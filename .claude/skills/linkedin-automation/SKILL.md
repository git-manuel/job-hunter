---
name: linkedin-automation
description: Reference for automating or scraping linkedin.com itself - URL/query parameters for jobs search and content (posts) search, DOM structure quirks (jobs-tab cards vs. the posts-search page which has no stable CSS selector at all), the Easy Apply modal flow and its Greenhouse-style "Additional Questions" step, the external-ATS handoff pattern, login/session-state detection, and concrete gotchas found driving LinkedIn via both playwright-java and Claude-in-Chrome (mcp__claude-in-chrome__*). Project-agnostic - use this whenever a task scrapes LinkedIn, drives LinkedIn via browser automation, or debugs why a LinkedIn selector/flow stopped working, regardless of which project it's for. For job-hunter's own package structure and business rules (candidate_data.yml, resume tailoring, apply routing), see the job-hunter skill instead.
---

# LinkedIn Automation Reference

Empirical notes from driving real linkedin.com pages via `playwright-java` (headed Chromium) and via `mcp__claude-in-chrome__*` (the user's real Chrome). LinkedIn ships obfuscated, per-session CSS class names almost everywhere - prefer functional attributes (`data-job-id`, `href` patterns), visible text/accessibility labels, and URL query parameters over guessing a class name, and expect to re-derive a selector occasionally as LinkedIn's DOM shifts.

## 1. Login / session state

Check the current URL after navigating to `https://www.linkedin.com/feed/`. If the session is unauthenticated, LinkedIn redirects to a URL containing one of: `/login`, `/authwall`, `/checkpoint`, `/uas/login`. This is a more durable check than any DOM element, since the logged-in nav bar's markup changes across LinkedIn revisions.

## 2. Jobs-tab search

URL: `https://www.linkedin.com/jobs/search/?keywords=<kw>&location=<loc>&f_WT=2&f_TPR=<bucket>&start=<offset>`

- `f_WT=2` = Remote workplace-type filter. `f_AL=true` = "LinkedIn Apply" (Easy Apply only) filter - useful for finding Easy Apply examples deliberately.
- `f_TPR` date buckets: `r86400` (past 24h), `r604800` (past week), `r2592000` (past month).
- `start=` is the pagination offset in increments of 25 (page 2 = `start=25`, etc.)
- Job cards: `[data-job-id]` - a stable functional attribute, unlike class names.
- Job title: `a[href*='/jobs/view/']` inside the card. **The link's `innerText` is often doubled** (a visible span plus a near-identical screen-reader span) - split on newlines and take the first non-empty line, don't use the raw `innerText`.
- Company name: `a[href*='/company/']` on the loaded detail pane (far more reliable than parsing the card's own text, which mixes in the same doubled-title problem). **The first matching link is frequently an image-only anchor with empty text** - scan the first several matches and take the first with non-blank text, don't blindly take `.first()`.
- Easy Apply vs external: a genuine Easy Apply job shows a blue **"🔵 Apply"** button (LinkedIn's own icon) directly on the job detail pane, no interstitial. An external-apply job shows **"Apply ↗"** with the external-link icon and the text "Responses managed off LinkedIn" - clicking it first shows a **"Share your profile?"** interstitial (toggle to share profile with the poster) with a "Continue ↗" button, which then opens the real external site in a new tab.

## 3. Content (posts) search - no stable selector exists

URL: `https://www.linkedin.com/search/results/content/?keywords=<kw>&datePosted=<bucket>&page=<n>`

- `datePosted` buckets: `past-24h`, `past-week`, `past-month`.
- **This page renders every result inside per-session, obfuscated atomic CSS classes** (e.g. `_51373152 _6c1ad861 _d64d459c ...`) with no `data-urn` attribute the way LinkedIn's main feed has. `[data-urn*='urn:li:activity']`, `.feed-shared-update-v2`, `.update-components-text`, `li.reusable-search__result-container`, `div.entity-result` - none of these match anything on this specific page. Don't waste time guessing more CSS selectors here.
- **The one reliable anchor**: every result carries a "Feed post" accessibility-label text node (screen-reader only, not visually rendered) right at the start. Use a `document.createTreeWalker(... SHOW_TEXT)` to find text nodes exactly equal to `"Feed post"`, then walk up `parentElement` until `innerText.length >= 200` (a handful of hops) to reach a container that plausibly wraps the whole post. From that container:
  - Author profile link: `el.querySelector("a[href*='/in/'], a[href*='/company/']")` - **but its own `innerText` is usually empty** (it wraps an avatar image, not the visible name text).
  - Author **name** is the second non-empty line of the container's own `innerText` (first line is the "Feed post" label itself).
  - Permalink (rare - most results don't expose one without opening a "..." menu): `Array.from(el.querySelectorAll('a')).map(a=>a.href).find(h => h.includes('/posts/') || h.includes('/feed/update/'))`.
  - Full post text (including hashtags, "… more" toggle text, and trailing UI chrome like "Like/Comment/Repost/Send") is present in `innerText` even when visually truncated behind a "see more" toggle - no need to click it open first.
- Lines to skip when hunting for the actual pitch/headline in the post text: the "Feed post" label; the author name line; connection-degree lines matching `^[•·]?\s*\d+(st|nd|rd|th)$` (e.g. `• 2nd`); relative-timestamp lines matching `^\d+[a-z]+\s*[•·].*$` (e.g. `7h •`); `Connect`/`Follow`/`Like`/`Comment`/`Repost`/`Send`. Even after skipping those, **the poster's own LinkedIn headline** (e.g. "Tech Recruiter", "Talent Specialist | Senior Tech Recruiter | HR") sits in the same run before the actual pitch and isn't otherwise distinguishable - preferring a longer line or one containing a pitch keyword ("hiring", "remote", "developer", "position", etc.) is a reasonable heuristic but not exact.

## 4. Easy Apply modal flow

A multi-step modal, roughly: **Contact info** (auto-filled from the user's real LinkedIn profile - name, phone country code, phone, email, all pre-populated) → **Resume** (shows previously-uploaded resumes with "last used" dates, selectable via radio, plus an "Upload resume" button) → **Additional Questions** (custom per-job screening questions, commonly "powered by Greenhouse" even though the UI is LinkedIn's own) → optional **EEO/demographic section** (gender, cultural background, sexual orientation, disability status, age bracket - generally has no required-field asterisks, i.e. legitimately optional) → **Review** → final submit.

Gotchas in the Additional Questions step:
- Native `<select>` dropdowns **do not reliably respond to coordinate-based `computer` clicks** on the rendered option text (the OS-level popup can render outside the normal click-hit-testing layer) - use `find` to get the element ref, then `form_input` with the option's visible text. This worked reliably in every case tested; coordinate clicks on native selects did not.
- Custom (non-native) comboboxes, like the ones seen on external ATS career sites (not LinkedIn's own Easy Apply modal), **do** need coordinate clicks to open, then a coordinate click on the option - `form_input` alone won't open them. Check whether an element is a real `<select>` (use `form_input`) or a styled div-based combobox (use `computer` clicks) before assuming which approach applies.
- A salary-expectation dropdown's **label text can say "in your local currency" while the actual `<option>` values are literal, differently-labeled brackets in multiple currencies** (e.g. `USD $60,000 - $70,000`, `MXN $1,200,000 - $1,400,000`, `BRL $200,000 - $250,000` all in the same list) - always read the actual option list (`read_page` with `filter: all` on the combobox ref) rather than trusting the question's label to tell you the unit.
- Closing the modal mid-flow (X button, or pressing Escape inside a sub-dialog) triggers a **"Save this application?" / "Leave?" confirmation** ("Discard" vs "Save"/"Cancel") - handle it explicitly rather than assuming the close action completed.

## 5. External ATS forms (after the "Apply ↗" redirect)

Once on the external site, expect a standard multi-field form: name/email/phone (may have an input mask - see gotcha below), resume upload, LinkedIn/portfolio URLs, and custom screening questions (often Yes/No, Sim/Não, or free-text) that vary entirely per company/ATS vendor (Greenhouse, Lever, Workday, bespoke). No universal selector set exists here either - use `read_page`/`find` per form.

- **Masked/formatted inputs** (e.g. a phone field rendered as `(00) 00000-0000`) can silently reject `form_input`'s direct value-set and revert to the placeholder, because the mask is JS-driven and intercepts real keystrokes that a synthetic value-set bypasses. Use character-by-character `computer` `type` actions instead for these fields.
- EEO/diversity self-identification questions (gender, race, sexual orientation, disability) are standard on many ATS forms and almost always optional (no required marker) - leave them unanswered rather than guessing, unless the user has explicitly provided that data somewhere.

## 6. File uploads via Claude-in-Chrome - fixed as of 2026-08-11

`mcp__claude-in-chrome__file_upload` failed with `"paths": expected array, received undefined` in every attempt made (2026-08-07 session) - tried both a real absolute path and a path inside Claude's own scratchpad/output folder, identical error both times, regardless of the target site (a LinkedIn Easy Apply resume field, a LinkedIn DM attachment, and an external ATS resume field all failed the same way). This looked like a harness-side tool-calling bug (the array parameter wasn't reaching the tool), not a legitimate "file not shared with this session" rejection.

**Re-verified working on 2026-08-11** against a real external ATS resume field (Sympla/InHire application form, `sympla.inhire.app`): used `find` to locate the file input (`type="file"`, no visible/stable selector), then called `file_upload` with `ref` + a `C:\workspace\...` absolute path in `paths`. The upload succeeded and the page's own UI updated to show the attached filename with a remove control - not just a silent tool-side success. Treat this as fixed; a Windows workspace-absolute path works, not just paths inside the session's scratchpad/attachments folders.

**Never click a file-input button directly** - it opens a native OS file picker dialog that cannot be seen or interacted with (press Escape to recover if this happens by accident). Use `read_page`/`find` to get the `<input type="file">` element's `ref`, then call `file_upload` with that `ref`. After uploading, take a screenshot or re-read the page to confirm the site's own UI reflects the attached file - don't trust the tool's success message alone.

## 7. LinkedIn messaging (DM)

Clicking "Message" on a profile opens a compose panel with an optional Subject field and a body textarea; a paperclip icon suggests attachment support in the UI, but is subject to the same file-upload limitation in §6. Sending a message to a non-connection is often still possible ("Free message") when there are mutual connections or the recipient has an open profile - don't assume you need to connect first.
