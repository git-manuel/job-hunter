# job-hunter — LinkedIn Job Automation (Spring Boot + hybrid automation)

## Context

The user wants to automate their LinkedIn job search: finding relevant postings (both the Jobs tab and recruiter Posts), tailoring a resume per company, and applying — via LinkedIn Easy Apply, an external ATS site, a LinkedIn DM, or an email — with a human-in-the-loop review UI before anything is actually sent. The project already exists as a bare Spring Boot 4.1.0 / Java 17 scaffold at `C:\workspace\job-hunter` (groupId `org.inclutech`, artifact `job-hunter`) with only `spring-boot-starter-webmvc` + devtools as dependencies, and one real asset: the user's current resume at `src/main/resources/initial-resume/Manuel_Almeida_Resume.pdf`. Everything else needs to be built.

**Key architecture decision made during planning — a hybrid split, driven by token/cost concerns:**

Two candidate designs were evaluated: (a) embedding `playwright-java` fully in the Spring app to do all browser work in deterministic, zero-LLM-cost Java code, vs. (b) having Claude drive the user's real, already-logged-in Chrome live via `mcp__claude-in-chrome__*` for everything. Option (b) alone was initially attractive (no login/session code needed, more resilient to LinkedIn DOM changes, no manual-step gate needed) but was rejected as the sole approach once token cost was considered: **every page read/screenshot during live browsing flows through Claude's context**, and bulk scraping (many job cards per search) would mean hundreds of tool calls and tens of thousands of tokens per session — a real, avoidable cost, since scraping is high-volume and mechanical.

The chosen design splits by volume and by which part actually benefits from an LLM's adaptability:
- **Search & scraping (high-volume, mechanical, many jobs per page)** → `playwright-java`, embedded in the Spring app, at essentially zero LLM cost. Classification signals (remote/hybrid/onsite, contact email, AI-testing suspicion, LinkedIn's own "Applied" badge) are extracted with deterministic Java heuristics — reviewed by the user in the UI, so imperfect regex extraction is caught by a human before anything is sent.
- **Apply execution (low-volume — only jobs the user actually approves — and needs real adaptability: Easy Apply modals, arbitrary external ATS forms, DMs)** → Claude drives the user's real Chrome, but only for the (typically much smaller) set of jobs marked `APPROVED_FOR_APPLY`. This is where an LLM's ability to read a form semantically and ask about anything unclear is actually worth the token spend.
- **Resume tailoring** stays with Claude (not a Java→Anthropic API call) — it's a single bounded text-generation call per job using data already in hand (job description text, `candidate_data.yml`), not a page-dump-heavy browsing operation, so it doesn't carry the same cost concern; keeping it in Claude avoids needing an Anthropic API key in the app at all.
- **Email sending** is never automatic on either side — the app writes an outbox file on Apply; a later chat session asks Claude to turn pending outbox entries into Gmail drafts via the already-connected Gmail MCP; the user sends manually from Gmail.

Net effect: the app needs no Anthropic API key (Claude does tailoring), but does need one small local LinkedIn session (Playwright's own login, separate from the user's regular Chrome) for the search side — see §0 for that tradeoff.

## 0. Guiding decisions

- **No database.** Files (YAML/Markdown/JSON) + in-memory singleton beans only — single-user personal tool.
- **Playwright owns search, Claude-in-Chrome owns apply execution.** Two separate browser identities are involved: Playwright's own headed Chromium instance (with its own persisted LinkedIn login, used only for searching/scraping) and the user's actual everyday Chrome (already logged in, driven live by Claude only for the smaller set of approved applications). This is a deliberate, accepted tradeoff — logging in twice (once during Playwright setup, which the user does once and it persists via storage state) is a small one-time cost against avoiding the much larger recurring token cost of doing all scraping through Claude.
- **No LLM calls from Java.** Claude generates tailored resume content directly (reads `candidate_data.yml` + the already-scraped job description text — no browsing needed for this) and pushes structured content to the app purely for rendering. Classification during search (remote/hybrid, contact email, AI-testing/temp signals) uses deterministic Java text heuristics instead, since it must run inline with high-volume scraping.
- **Two data areas, split by purpose:**
  - `src/main/resources/` — static template assets (resume HTML/CSS template) **plus** a gitignored `resumes/` subfolder for generated, per-company resume PDFs (honors the user's literal "resume folder under resources" request while keeping generated PII out of git).
  - Project-root `data/` (gitignored) — `candidate_data.yml`, `missing_data_log.jsonl`, the email outbox, the Playwright search-session storage state. Exception: `data/ai_testing_companies.yml` stays **tracked** (no PII, meant to grow durably over time).
  - `source/` (project root, tracked) — `message_to_recruiter.md`, the shared, hand-edited message template.
- **Human stays in the loop everywhere.** Suggest-skip is only ever a suggestion. The **Apply** button (renamed from "Send" per the user) always requires an explicit click. Manual steps during search (Playwright hitting a CAPTCHA/login prompt) pause and wait for the user via the same gate mechanism the UI already needs for progress display; manual steps during apply execution are just handled directly in the Chrome window Claude is driving.
- **Email is never sent automatically by anyone.** Clicking Apply on an email-routed job writes an outbox file (Java does this synchronously — no Claude/browser step needed). The actual Gmail draft is created later, when the user asks Claude (in a chat session, using the already-connected Gmail MCP) to process the outbox. Sending the draft is a manual click by the user in Gmail. See §6.

## 1. Package structure

```
org.inclutech.jobhunter
├── JobHunterApplication.java
├── config/
│   ├── JobHunterProperties.java        # @ConfigurationProperties("jobhunter") — data-dir paths, salary floors
│   └── PlaywrightConfig.java           # single-thread ExecutorService bean — all Playwright calls run on it
├── candidate/
│   ├── CandidateProfile.java           # record(s) mirroring candidate_data.yml
│   ├── CandidateDataService.java       # load/save candidate_data.yml
│   └── MissingDataService.java         # append/read data/missing_data_log.jsonl
├── resume/                             # rendering only — Claude supplies the tailored content
│   ├── ResumeTemplateService.java      # merges tailored content (from Claude) + CandidateProfile into resume HTML
│   ├── ResumePdfRenderer.java          # openhtmltopdf: HTML+CSS -> PDF
│   └── ResumeFileService.java          # naming convention, resources/resumes/, last_sent/ copy-on-apply
├── linkedin/                           # search-only Playwright automation, isolated from apply logic
│   ├── PlaywrightBrowserService.java   # on-demand headed browser lifecycle, storage-state load/save
│   ├── LinkedInAuthService.java        # login detection, manual-login flow (search session only)
│   ├── LinkedInPostsSearchService.java # posts search scrape
│   ├── LinkedInJobsSearchService.java  # jobs-tab search scrape
│   ├── LinkedInSelectors.java          # centralized selectors — the one place to fix when LinkedIn's DOM changes
│   ├── TextSignalExtractor.java        # regex/keyword heuristics: contact email, remote/hybrid/onsite fallback, temp/contract, subject-format hints
│   └── ManualStepGate.java             # pause/resume primitive, used during search (login, CAPTCHA)
├── screening/
│   └── AiTestingCompanyFilter.java     # list matching against data/ai_testing_companies.yml — server-authoritative
├── apply/
│   ├── ApplyRoutingService.java        # pure decision logic: source + signals -> ApplyAction
│   └── ApplyQueueState.java            # in-memory: current page, pending/awaiting-tailoring/approved/sent/skipped counts
├── outbox/
│   └── EmailOutboxService.java         # writes/lists pending|drafted|sent outbox files
└── web/
    ├── DashboardController.java        # Thymeleaf dashboard + search-trigger buttons
    ├── JobReviewController.java        # Thymeleaf review page; Apply/Skip form actions
    ├── JobApiController.java           # REST, called by Claude: pending-for-tailoring, resumes/render, approved-for-apply, mark-applied
    └── AutomationStatusController.java # /api/automation/status + /continue — search-side manual-step gate (polled by dashboard JS)
```

`linkedin/` and `apply/` stay separate packages on purpose — search automation (Playwright, LinkedIn's DOM) and apply automation (Claude-in-Chrome, decision routing) have different failure modes and different owners (compiled Java vs. live chat-driven), so nothing about one should leak into the other beyond the shared `ApplyQueueState`/data files.

## 2. Data files

| File | Location | Tracked in git? |
|---|---|---|
| `candidate_data.yml` | `data/` | No |
| `message_to_recruiter.md` | `source/` | Yes |
| `ai_testing_companies.yml` | `data/` | **Yes** (only exception — no PII, meant to grow durably) |
| `missing_data_log.jsonl` | `data/` | No |
| Outbox entries | `data/outbox/{pending,drafted,sent}/*.yml` | No |
| Playwright search-session state | `data/playwright/linkedin-storage-state.json` | No |
| Generated resumes | `src/main/resources/resumes/<Company>-Manuel-Almeida-.pdf` | No (gitignore this subfolder) |
| Last-sent resume | `src/main/resources/resumes/last_sent/Manuel-Almeida.pdf` | No |

**`candidate_data.yml`** — seeded in Phase 0 from the resume PDF already on disk (contact, summary, skills, experience per company, education, professional development, languages), plus:
```yaml
compensation:
  salary_floor_usd_monthly: 4000
  salary_floor_brl_monthly: 15000
  salary_floor_eur_monthly: 3471
  rule: "Use the HIGHER of the applicable floor or the top of any range stated in the post. Convert to hourly from whichever monthly figure applies if asked."
```
**Known gaps to ask the user about in Phase 0** (do not invent): GitHub/portfolio links, work-authorization/visa status, notice period.

**`ai_testing_companies.yml`** — small seed list, matched case-insensitively against company name/domain by `AiTestingCompanyFilter`; `TextSignalExtractor` also flags description-text keywords ("AI training", "RLHF", "prompt rating", "data labeling") as a secondary signal. Both are best-effort — the review UI is the real backstop, since the user sees every job before applying.

**`missing_data_log.jsonl`** — one JSON object per line, append-only, surfaced as a dashboard alert banner:
```json
{"timestamp":"...","job_id":"...","company":"...","field":"work_authorization.status","context":"..."}
```

## 3. Playwright search design

- Dependency: `com.microsoft.playwright:playwright` (official Java port), in-process — no Node subprocess. Scoped to search/scraping only.
- `PlaywrightBrowserService` lazily launches Chromium **headed** on first search trigger (kept alive across searches; `@PreDestroy` close + a manual "Close Browser" dashboard action).
- **Thread affinity**: all Playwright calls run on one dedicated single-thread `ExecutorService` (`PlaywrightConfig`) — Spring MVC threads never touch Playwright objects directly. The #1 gotcha to get right early.
- **Session persistence**: `browserContext.storageState(path)` written after the one-time manual login; loaded via `newContext(storageStatePath)` on later runs, so the user doesn't re-log-in every search session. If the loaded state turns out not-logged-in, fall back to the manual-login flow again.
- **`ManualStepGate`** — pause/resume primitive for search-time manual steps (first login, an in-session CAPTCHA):
  ```java
  class ManualStepGate {
      enum Status { NONE, AWAITING_MANUAL_STEP }
      volatile Status status; volatile String reason;
      CompletableFuture<Void> resumeSignal;
      void pauseAndWait(String reason) { ...; resumeSignal.join(); }   // blocks only the Playwright thread
      void resume() { resumeSignal.complete(null); }
  }
  ```
  `GET /api/automation/status` is polled (~2s) by dashboard JS to show a reason banner; `POST /api/automation/continue` calls `resume()`.
- **`TextSignalExtractor`** — the deterministic classification layer that replaces an LLM call during scraping: regex email extraction from post text, keyword-based remote/hybrid/onsite fallback (LinkedIn's own label chip is trusted first where present), temp/contract keyword detection, and best-effort "preferred channel"/"stated subject format" phrase matching (e.g. "email your resume to", "DM me", "subject line should be"). Explicitly best-effort — flagged in the UI, corrected by the human reviewer, not treated as ground truth.

## 4. LinkedIn search flows

**Posts search**: navigate LinkedIn content search with the literal filter `"JAVA" AND (USD OR DOLLAR) AND (LATAM OR BRAZIL OR BRASIL)`. LinkedIn only exposes coarse date buckets, not an arbitrary range — map the user's requested range to the nearest bucket and post-filter by relative-time text as a backstop (flagged as a risk, §9). Each scraped post runs through `TextSignalExtractor` for contact email / preferred channel / subject format / AI-testing & temp signals.

**Jobs-tab search**: navigate `linkedin.com/jobs/search/` filtered to Brazil + remote (`f_WT=2`) + nearest date bucket. Scrape card list, then detail pane per job. **"Already applied" dedupe relies entirely on LinkedIn's own "Applied" badge**, read directly off the page at scrape time — no separate persistent dedupe store is built, per the user's explicit instruction.

**Skip / suggest-skip** (never auto-skip): not remote, temp/contract signal, or `AiTestingCompanyFilter`/keyword match → suggested in the review UI, user decides.

**Pagination gated by full review**: `ApplyQueueState.canAdvancePage()` returns true only once every item on the current page has left `PENDING` (sent/outboxed or skipped) — the "Next Page" control stays disabled until then.

## 5. Resume rendering pipeline

- **Trigger**: after a search populates the queue, the user asks Claude (in a chat session) to "tailor resumes for pending jobs." Claude calls `GET /api/jobs/pending-tailoring`, and for each job reads the already-scraped description text (no browsing needed — the text is already stored from the Java scrape) plus `candidate_data.yml`, generates tailored content, and calls `POST /api/resumes/render`. This is a bounded, cheap, per-job text-generation call — not a page-dump — so it doesn't carry the browsing-cost concern that drove the search/apply split.
- **Render input**: `{company, summary, coreCompetencies, selectedExperience: [{company, role, startDate, endDate, location, bullets}], highlightedSkills}` — Claude is responsible for never inventing facts not present in `candidate_data.yml`.
- **Template**: `src/main/resources/resume-template/resume-template.html` (Thymeleaf, rendered standalone via `TemplateEngine` — not through the web MVC dispatcher) mirroring the sections in the initial PDF: Summary, Core Competencies, Technical Skills, Experience, Education, Professional Development, Languages. Static parts (contact, education, professional development, languages) come from `CandidateProfile`, not Claude's per-job payload.
- **Rendering**: **openhtmltopdf** (`com.openhtmltopdf:openhtmltopdf-pdfbox`) — pure Java, no external Chromium/Node dependency, actively maintained. CSS limited to its ~2.1 subset (no flexbox/grid) — expect "clean and professional," not pixel-parity with the original. Needs an explicitly bundled TTF font (e.g. Liberation Sans) under `src/main/resources/fonts/`.
- **File lifecycle**: render → write `src/main/resources/resumes/<Company>-Manuel-Almeida-.pdf` (draft) → embedded in the review UI → on **Apply**, copied to `src/main/resources/resumes/last_sent/Manuel-Almeida.pdf` (flat, overwritten) before use as the Easy Apply upload / external-site upload / email attachment.

## 6. Apply routing + email outbox

`ApplyRoutingService.decide(QueueItem)` — pure function, computed at ingest time from the `TextSignalExtractor` signals:

```java
sealed interface ApplyAction {
    record EasyApply() implements ApplyAction {}
    record ExternalSiteApply(String url) implements ApplyAction {}
    record SendEmail(String recipientEmail, String subjectOverride) implements ApplyAction {}
    record SendLinkedInMessage() implements ApplyAction {}
}
```

- **Source = Jobs tab** → never email. `EasyApply` if detected during scraping, else `ExternalSiteApply(url)`.
- **Source = Posts** → `SendEmail` if a contact email was extracted; else `SendLinkedInMessage`. A recruiter's explicitly stated channel/subject preference (from `TextSignalExtractor`) overrides these defaults.

**Email hand-off (outbox)** — nobody calls Gmail directly at Apply time. On a `SendEmail` apply, `EmailOutboxService` writes `data/outbox/pending/<timestamp>-<company-slug>.yml` immediately, synchronously, in Java — no Claude/Chrome step needed for this path at all:
```yaml
id: "20260806-153000-acme-corp"
job: {company: Acme Corp, title: Senior Backend Engineer, post_url: "...", recruiter_name: Jane Doe}
recipient_email: jane.doe@acme.com
subject: "Interested in Senior Backend Engineer at Acme Corp"   # message_to_recruiter.md placeholders filled in, honoring any recruiter-stated override
body: |
  Hi Jane, ...
resume_path: "src/main/resources/resumes/last_sent/Manuel-Almeida.pdf"
```
Lifecycle is **file location, not just a status field**: `pending/` → (in a later chat session, the user asks Claude to "process the job-hunter outbox" — Claude reads pending files, calls the Gmail MCP's `create_draft`, moves the file to `drafted/`) → `sent/` (moved once the user has actually hit Send in Gmail — a manual "Mark Sent" dashboard action does the file move). The dashboard shows the `pending/` count as "awaiting Gmail draft."

**Browser-executed actions (`EasyApply`, `ExternalSiteApply`, `SendLinkedInMessage`)** — clicking **Apply** in the review UI marks the job `APPROVED_FOR_APPLY`; it now appears in `GET /api/jobs/approved-for-apply`. When the user is ready, they ask Claude to "process approved applications" — Claude drives the user's real Chrome (`mcp__claude-in-chrome__*`) for just that (typically small) batch: fills the Easy Apply modal or external-site form from `candidate_data.yml`, or sends the rendered `message_to_recruiter.md` text as a DM, asking the user directly about anything unmapped (no special app-level gate needed — it's already an interactive chat), then calls `POST /api/jobs/{id}/mark-applied`. LinkedIn's DM UI likely doesn't support attachments — verify live in Phase 5; if not, the message should mention the resume is available on request. Full automation across every ATS platform is explicitly out of scope — "assist and ask," not "fully automate."

## 7. UI (Thymeleaf, minimal vanilla JS — no build step)

- **`dashboard.html`** (`GET /`) — date-range form + "Start Posts Search" / "Start Jobs Search" buttons (these trigger the Java Playwright flows); progress panel (found, pending, awaiting-tailoring, approved-awaiting-apply, sent, skipped); missing-data alert banner; outbox pending/drafted/sent counts; manual-step banner (polled) for search-time pauses.
- **`review.html`** — one job at a time: source badge ("From: Posts Search" / "From: Jobs Tab"), job description, embedded tailored-resume PDF (or "resume not yet generated — ask Claude to tailor pending jobs" if tailoring hasn't run yet), message preview (or "no message — automated application" for Easy Apply/external routes), route indicator ("Will route via: Email to jane@acme.com" / "LinkedIn Message" / "Easy Apply" / "External site — Claude will handle this live"), inline missing-data alert, **Apply** and **Skip** (with optional reason, feeding `AiTestingCompanyFilter`) buttons.

## 8. Phased build order

| Phase | Scope | Needs the user? |
|---|---|---|
| **0 — Skeleton, config, candidate_data** | Add deps (Thymeleaf, playwright-java, openhtmltopdf, jackson-dataformat-yaml — no Anthropic SDK). Package skeleton. `data/` dir + `.gitignore` (with the `ai_testing_companies.yml` exception). Transcribe `candidate_data.yml` from the resume PDF. Draft `message_to_recruiter.md` + resume HTML/CSS template. Seed `ai_testing_companies.yml`. | **Yes** — answers to the candidate-data gaps (GitHub/portfolio, work-auth, notice period). |
| **1 — Resume rendering pipeline (isolated)** | `CandidateDataService`, `ResumeTemplateService`, `ResumePdfRenderer`, `ResumeFileService`, `/api/resumes/render`. Test with hand-written sample payloads standing in for what Claude will later generate. No browser involved. | **Yes** — review a few generated resumes for quality before building on top. |
| **2 — Playwright login/session persistence (search)** | `PlaywrightBrowserService`, `LinkedInAuthService`, `ManualStepGate`, `PlaywrightConfig`. Confirm the second run reuses the saved storage state with no visible re-login. | **Yes, heavily** — first LinkedIn login (likely 2FA) done by hand in the visible Playwright browser window. |
| **3 — Jobs-tab search + ingest + review/skip loop** | `LinkedInJobsSearchService`, `TextSignalExtractor`, `AiTestingCompanyFilter`, `ApplyRoutingService`, `ApplyQueueState`, dashboard + review views, pagination-gated-by-full-review. Wire up the "ask Claude to tailor pending jobs" flow end-to-end against real scraped jobs. | Iteration-heavy against the live site; spot-checks on scraping/classification accuracy. |
| **4 — Posts search + email outbox** | `LinkedInPostsSearchService`, `EmailOutboxService`, `ApplyRoutingService` (posts branch). | Live verification that the boolean filter string behaves as expected. |
| **5 — Claude-in-Chrome apply execution** | Claude drives the user's real Chrome for `APPROVED_FOR_APPLY` jobs: Easy Apply modal fill, external-site best-effort autofill, LinkedIn DM send, `mark-applied` wiring, `last_sent/Manuel-Almeida.pdf` copy-on-apply across all paths. One live outbox → Gmail MCP draft round-trip. | **Yes** — live session per batch of approved applications; confirm the Gmail hand-off produces a correct draft with the resume attached. |
| **6 — Polish (optional)** | Standalone outbox view, richer AI-testing-list management, `TextSignalExtractor` accuracy tuning based on real misses. | Low. |

Phase 3 (live LinkedIn DOM + classification heuristics) and Phase 5 (arbitrary external ATS sites) carry the most uncertainty — budget the most iteration time there.

## 9. Open risks

1. **LinkedIn ToS / anti-bot detection.** Automated scraping, messaging, and applying — even human-paced — is against LinkedIn's User Agreement and carries real account risk on both browser identities involved. The user is accepting this for personal, low-volume use.
2. **Selector brittleness** (search side) — LinkedIn's DOM/classes shift often; centralized in `LinkedInSelectors`, prefer text/aria-label selectors over generated class names.
3. **Regex/keyword classification is imperfect** — `TextSignalExtractor`'s email/channel/subject/remote-fallback/AI-testing/temp detection will sometimes miss or misfire on free-form post text; the review UI is the real backstop since a human checks every job before applying.
4. **Search-operator support is undocumented** — whether the literal filter string is honored as real boolean logic, and how precisely LinkedIn's date UI maps to an arbitrary range, needs live verification in Phase 4.
5. **PDF fidelity** — openhtmltopdf gives clean output, not pixel-parity with the original resume design.
6. **Full ATS automation is unrealistic** — Phase 5's external-site handling is "best-effort autofill, ask when unsure."
7. **LinkedIn DM attachments** likely unsupported — verify in Phase 5.
8. **Storage-state can be invalidated** by LinkedIn's own security checks independent of normal expiry — always detect "not logged in" at the start of a search run and re-trigger manual login rather than fail unexpectedly.
9. **Playwright thread-affinity** — must be respected via the dedicated single-thread executor (§3); the most common source of confusing runtime errors if skipped.
10. **Two separate LinkedIn sessions** (Playwright's own for search, the user's real Chrome for apply) is a minor ongoing quirk — e.g. an Easy Apply job scraped via Playwright's session must still work when Claude opens it in the user's Chrome; both need to be logged in independently.

## Verification

- **Phase 1**: POST hand-written `TailoredResumeContent`-shaped payloads to `/api/resumes/render`, inspect the resulting PDFs for layout quality and correct data merge.
- **Phase 2**: run the app twice — confirm the second run reuses the saved storage state and lands on LinkedIn already authenticated.
- **Phase 3**: run a real jobs-tab search over a short date range; walk the review UI for a handful of real results; confirm pagination stays gated until the page is cleared; confirm "Applied"-badge jobs are excluded; ask Claude to tailor a couple of pending resumes and inspect the output.
- **Phase 4**: run a real posts search; spot-check `TextSignalExtractor`'s email/channel extraction against a few real posts; confirm an outbox YAML is written correctly on Apply.
- **Phase 5**: apply end-to-end to a couple of real Easy Apply jobs and a couple of real external-ATS jobs via Claude-in-Chrome, confirming `last_sent/Manuel-Almeida.pdf` updates each time; do one live outbox → Gmail MCP draft round-trip and confirm the draft is correct; send one real LinkedIn DM.
