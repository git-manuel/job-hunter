// Category-matching autofill: scan the page for fillable fields, match each one against the
// local alias dictionary (field-categories.js), fill matches instantly with zero AI/network
// involvement, and hand unmatched fields to an in-page modal (never to Claude — see
// category-modal.js). File attachments are the one hard exception: browsers permanently block
// scripts from assigning `.files`, so those always queue a pending action for a live Claude
// session regardless of how confidently the field was categorized.
(function () {
  const JH = self.JH || (self.JH = {});

  // ---------- on-page toast (shared by autofill, cover-letter, and context-menu flows) ----------

  const TOAST_COLORS = { info: "#1D4ED8", success: "#15803D", error: "#B91C1C" };

  JH.showToast = function showToast(message, { isError = false, kind } = {}) {
    const resolvedKind = kind || (isError ? "error" : "info");
    const existing = document.getElementById("job-hunter-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "job-hunter-toast";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: 2147483647,
      maxWidth: "360px",
      padding: "12px 16px",
      borderRadius: "8px",
      background: TOAST_COLORS[resolvedKind] || TOAST_COLORS.info,
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      lineHeight: "1.4",
      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  };

  // Small top-of-page progress indicator for the auto-complete run — separate from showToast
  // (bottom-right, one-shot) because this one is a single persistent element whose text gets
  // updated in place across the run, so the user sees live progress instead of stacked toasts.
  // pointerEvents:"none" and a small top-right footprint keep it from blocking page navigation.
  JH.showStatusBanner = function showStatusBanner(message, { isError = false } = {}) {
    let banner = document.getElementById("job-hunter-status-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "job-hunter-status-banner";
      Object.assign(banner.style, {
        position: "fixed",
        top: "8px",
        right: "8px",
        zIndex: 2147483647,
        maxWidth: "320px",
        padding: "6px 12px",
        borderRadius: "6px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "12px",
        lineHeight: "1.3",
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        pointerEvents: "none",
        transition: "opacity 0.2s linear",
      });
      document.body.appendChild(banner);
    }
    banner.textContent = message;
    banner.style.background = isError ? "#B91C1C" : "#1D4ED8";
    banner.style.color = "#fff";
    banner.style.opacity = "1";
    clearTimeout(banner._jhHideTimer);
    banner._jhHideTimer = setTimeout(() => {
      banner.style.opacity = "0";
    }, 15000);
  };

  // Live progress broadcast while Claude is actively resolving a pending item for *this* tab
  // (see JH.setProcessingStatus) — scoped to the matching URL so other open tabs stay quiet.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const change = changes[JH.STORAGE_KEYS.PROCESSING_STATUS];
    if (change && change.newValue && change.newValue.url === location.href) {
      JH.showToast(change.newValue.message, { kind: change.newValue.kind });
    }
  });

  // ---------- best-effort page context scraping (company/role/recruiter), for template placeholders ----------

  JH.scrapePageContext = function scrapePageContext() {
    const context = { company: "", role_title: "", recruiter_name: "" };
    if (location.hostname.includes("linkedin.com")) {
      const companyLink = Array.from(document.querySelectorAll("a[href*='/company/']")).find(
        (a) => a.textContent.trim().length > 0
      );
      if (companyLink) context.company = companyLink.textContent.trim();

      const titleLink = document.querySelector("a[href*='/jobs/view/']");
      if (titleLink) {
        const firstLine = titleLink.innerText.split("\n").map((s) => s.trim()).find(Boolean);
        if (firstLine) context.role_title = firstLine;
      }

      const profileLink = document.querySelector("a[href*='/in/']");
      if (profileLink && location.pathname.startsWith("/in/")) {
        const h1 = document.querySelector("h1");
        if (h1) context.recruiter_name = h1.textContent.trim();
      }
    }
    return context;
  };

  // ---------- main autofill flow ----------

  async function fillMatchedField(m, candidateData, dictionary) {
    if (m.category === "cover_letter") {
      await JH.handleCoverLetterField(m.element);
      return "filled";
    }

    const value = await JH.resolveCategoryValue(m.category, candidateData, dictionary);
    if (value === undefined || value === "") return "skipped";

    if (value === "__ATTACHMENT__") {
      JH.showToast(
        `job-hunter: found the ${m.category.replace(/_/g, " ")} field — ask Claude to attach your resume, it can do this live.`
      );
      return "needs-attachment";
    }

    const inputType = JH.detectInteractionType(m.element);
    const result = await JH.setFieldValue(m.element, inputType, value);
    if (result === "needs-attachment") {
      JH.showToast(
        `job-hunter: found the ${m.category.replace(/_/g, " ")} field — ask Claude to attach your resume, it can do this live.`
      );
      return "needs-attachment";
    }
    return result ? "filled" : "failed";
  }

  // Guards against two concurrent runs corrupting each other's UI — confirmed happening in
  // practice when the Ctrl+Shift+U shortcut and Claude's "run-auto-complete" debug hook (see
  // agent-bridge.js) both fired on the same tab close together: with no guard, two runAutoComplete
  // calls interleave, and since category-modal.js's overlay uses a fixed (non-unique) DOM id,
  // both instances' modals end up visually stacked on top of each other.
  let autoCompleteInFlight = false;

  async function runAutoComplete() {
    if (autoCompleteInFlight) {
      JH.showStatusBanner("job-hunter: already running — ignoring duplicate trigger.");
      return;
    }
    autoCompleteInFlight = true;
    try {
      await runAutoCompleteInner();
    } finally {
      autoCompleteInFlight = false;
    }
  }

  async function runAutoCompleteInner() {
    JH.showStatusBanner("job-hunter: scanning page…");

    const candidateData = await JH.getCandidateData();
    if (!candidateData) {
      JH.showStatusBanner("job-hunter: no candidate data saved yet — add it on the options page.", { isError: true });
      return;
    }

    const dictionary = await JH.getEffectiveCategoryDictionary();
    const scanned = JH.scanFormFields();

    const matched = [];
    const unmatched = [];
    for (const item of scanned) {
      const m = JH.matchCategory(item.signature, dictionary);
      (m ? matched : unmatched).push(m ? { ...item, ...m } : item);
    }

    let filled = 0;
    let attach = 0;
    let failed = 0;

    for (const [i, m] of matched.entries()) {
      JH.showStatusBanner(`job-hunter: filling field ${i + 1}/${matched.length}…`);
      const outcome = await fillMatchedField(m, candidateData, dictionary);
      if (outcome === "filled") filled++;
      else if (outcome === "needs-attachment") attach++;
      else if (outcome === "failed") failed++;
    }

    const toPrompt = await JH.filterIgnored(unmatched, location.origin);
    for (const field of toPrompt) {
      const decision = await JH.showCategoryModal(field, dictionary, candidateData);
      if (decision && (decision.action === "linked" || decision.action === "created")) {
        const freshDictionary = await JH.getEffectiveCategoryDictionary();
        const outcome = await fillMatchedField({ ...field, category: decision.category }, candidateData, freshDictionary);
        if (outcome === "filled") filled++;
        else if (outcome === "needs-attachment") attach++;
      }
    }

    JH.showStatusBanner(
      `job-hunter: filled ${filled} field(s)` +
        (attach ? `, ${attach} attachment(s) queued for Claude` : "") +
        (failed ? `, ${failed} failed` : "") +
        "."
    );
  }

  // Exposed on JH so agent-bridge.js can trigger a fill directly (via postMessage from any page
  // Claude is on) without going through chrome.commands — browser-automation tools can't dispatch
  // the real Ctrl+Shift+U shortcut, so this is the only way Claude can test the fill logic itself.
  JH.runAutoComplete = runAutoComplete;

  // ---------- message wiring from background (context menu / F9 trigger) ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "job-hunter:auto-complete") {
      JH.showStatusBanner("job-hunter: command received…");
      runAutoComplete().then(() => sendResponse({ ok: true }));
      return true; // keep the message channel open for the async response
    }
    return undefined;
  });
})();
