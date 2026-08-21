// Cover-letter field handling: instant reuse on a per-company cache hit, otherwise a Claude
// hand-off (via the pending-actions queue, see storage-schema.js) that drafts + caches (text +
// PDF) once so every later form for that company is instant. Wired into autofill-engine.js's
// fill pass via JH.handleCoverLetterField.
(function () {
  const JH = self.JH || (self.JH = {});

  function isFileField(field) {
    return field.tagName === "INPUT" && field.type === "file";
  }

  JH.handleCoverLetterField = async function handleCoverLetterField(field, formCacheKey) {
    const context = JH.scrapePageContext();
    const companyName = context.company || document.title;
    const companySlug = JH.slugifyCompany(companyName);

    const existing = await chrome.runtime.sendMessage({
      type: "job-hunter:get-cover-letter",
      payload: { companySlug },
    });

    if (existing && existing.ok && existing.payload) {
      const record = existing.payload;
      if (isFileField(field)) {
        JH.showToast(
          `job-hunter: found the cover letter field — ask Claude to attach the cached cover letter for ${record.companyDisplayName}, it can do this live.`
        );
      } else {
        JH.setFieldValue(field, field.tagName === "TEXTAREA" ? "textarea" : "text", record.plainText);
        JH.showToast(`job-hunter: filled cached cover letter for ${record.companyDisplayName} — zero AI calls.`);
      }
      return;
    }

    // Cache miss: queue a drafting request, cached going forward for this company.
    await JH.queuePendingAction({
      type: "draft-cover-letter",
      url: location.href,
      companySlug,
      companyDisplayName: companyName,
      isFileField: isFileField(field),
    });
    JH.showToast(
      `job-hunter: no cached cover letter for ${companyName} — queued a drafting request, Claude will pick this up next time you check in.`
    );
  };
})();
