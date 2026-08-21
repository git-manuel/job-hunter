---
name: inhire-ats
description: Reference for navigating and filling job application forms on InHire, a Brazilian multi-tenant ATS platform where each employer gets a subdomain like <company>.inhire.app (e.g. sympla.inhire.app). Use this whenever a job-hunter apply-execution task lands on an inhire.app job posting - it covers the "Apply for the job" panel flow, the exact form fields on step 1, and a non-obvious masked-input gotcha on the salary field that will silently produce a wildly wrong number if you type digits the way you would for a normal currency input. For general external-ATS handoff patterns (detecting the redirect, generic form-filling approach) see the linkedin-automation skill instead - this skill is specific to InHire's own DOM/UX quirks.
---

# InHire ATS

Empirical notes from `sympla.inhire.app` (2026-08-11), driven via `mcp__claude-in-chrome__*` against the user's real Chrome. InHire is multi-tenant - other employers will have their own `<company>.inhire.app` subdomain, presumably sharing the same frontend, so these notes should transfer, but re-verify field labels/order per posting since employers can customize which fields appear.

## Page structure

The job posting itself is a single static page (title, location tags, full description) with a black **"Apply for the job"** button near the top. Clicking it does **not** navigate to a new URL - it reveals a right-hand side panel containing the application form, sitting alongside the still-visible job description on the left.

## Step 1 form fields (in order)

- **Full name** - plain text input
- **Your best email** - `type="email"` input
- **Cell phone with area code** - a country-selector combobox (flag icon, defaults to US 🇺🇸 +1) immediately left of a `type="tel"` text input. See gotcha below.
- **Linkedin** - plain text input (placeholder `https://linkedin.com/in/seu-perfil`), plus a "Get the link to your linkedin profile" helper link
- **Resume** *(required)* - a custom dropzone showing an "Attach resume" button. The real `<input type="file">` is a separate, differently-labeled element - locate it with `find` (query something like "resume file upload input"), don't trust the visible button's own ref. Confirmed working via `mcp__claude-in-chrome__file_upload` with a `paths` entry - see the linkedin-automation skill §6 for the general rule (never click a file input directly).
- **Salary as employee** *(required)* - masked currency input, placeholder `R$ 0.000,00`. See gotcha below.
- **Were you referred by someone in the company?** - Yes/No radio, defaults to "No"
- **Continue registration** button - submits step 1 (shows a brief in-button loading spinner while it POSTs), then opens a full-screen modal overlay for **step 2: a Typeform-embedded screening questionnaire** ("Responda as perguntas para finalizar sua inscrição" / "Answer the questions to complete your registration"), with an "Iniciar"/Start button (or press Enter). Treat clicking "Continue registration" as an actual form-submission action requiring the user's explicit go-ahead, same as any other "submit"/"continue" control in an apply flow - it is not just a client-side step change, it creates/updates a real candidate record.

## Step 2: Typeform screening questionnaire

After step 1 submits, a modal opens hosting a Typeform-style flow (confirmed via inspecting the DOM: it's a same-size iframe covering the modal, cross-origin, `src` blocked from reading by the browser - one question per screen, single-select tile options, a progress bar bottom-right, "press Enter" hint). Question content is per-posting/per-employer (the one instance seen asked about Java/Kotlin/framework/architecture/API/cloud experience, each a 4-tile single-select from "no experience" to "advanced") - don't assume the same questions appear elsewhere, but the interaction mechanics below should transfer.

- **Single-select tiles auto-advance on click** for every question except the last - clicking an option immediately moves to the next question, no separate "OK" click needed despite the visible OK button.
- **Clicking a tile twice deselects it.** If you click a tile, then click it again later (e.g. to "confirm" the selection), the second click toggles it off. Symptom: a "Este campo é obrigatório!" (this field is required) validation error appears where you didn't expect one. Fix: click the tile once more to reselect, verify it shows the solid-border selected state, and stop clicking it.
- **On the final question, the submit button (labeled "Enviar") does not reliably respond to coordinate-based `computer` clicks.** Repeated clicks directly on its visible center (verified via `zoom`) produced no visible change and no network request at all (confirmed via `read_network_requests` with tracking active) across ~4 attempts, including with 2-5s waits after each. **What worked:** after selecting the final tile (leaving focus on it), press `Tab` once (moves focus to the "Enviar" button - visible via a focus ring), then press `Return`. This submitted immediately and produced a "Registration successful!" confirmation modal. Prefer this Tab+Enter pattern over coordinate clicks for this button from the start, rather than burning attempts on clicking.
- **Answering honestly rather than maxing every tile matters.** Don't default to the top/most-advanced tile - cross-check each question against `candidate_data.yml`'s actual experience (e.g. a language only used ~2 years at one job should get the "2-4 years production" tier, not the "4+ years advanced" tier, even though the posting is for a senior role and the tempting answer is the impressive one).

## After submission

A "Registration successful!" modal confirms with the job title and "We will contact you shortly," plus job-share buttons (Facebook/LinkedIn/WhatsApp - not relevant to apply automation) and a "Close" button.

## Gotcha: country/phone combobox

The flag dropdown is a custom searchable combobox, not a native `<select>` - `form_input` won't work on it.

1. Click the flag icon to open it (opens a "Search the country" text box + scrollable list)
2. Type a search term (e.g. `Brasil`) into the box that appears
3. Click the matching result (e.g. "Brasil +55")
4. The adjacent tel field then accepts plain digits typed via `computer type` (e.g. `21982269642`) and auto-formats to `+55 21 98226 9642` - no need to type the `+55` yourself once the country is selected.

## Gotcha: salary field mask does NOT treat trailing digits as cents

This is the one most likely to silently produce a wrong value if you assume standard masked-currency behavior (where the last two typed digits become cents, e.g. typing `1500000` for R$15.000,00).

**That assumption is wrong here.** The field takes whatever digits you type as the literal integer amount and always appends a fixed `,00`. Typing `1500000` (7 digits) produced **R$ 1.500.000,00** (1.5 million) - not R$ 15.000,00 as you'd expect from a cents-aware mask.

To enter a round-number monthly salary like 15000, type exactly `15000` (5 digits, no padding) - the field formats it to `R$ 15.000,00` on its own.

If a field ever shows an unexpected value after typing, don't assume it's close enough - zoom/screenshot the field and verify the displayed number before moving on. To clear a wrong value: click into the field, `ctrl+a`, then repeated `BackSpace` until it reverts to the `R$ 0.000,00` placeholder, then retype.
