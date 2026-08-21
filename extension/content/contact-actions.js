// Handlers for the "JH - Draft email with resume" and "JH - Message with resume" context menu
// actions. Everything deterministic (recipient parsing, template placeholder fill) happens here
// in plain JS; the actual send + attachment always needs a live Claude hand-off (see the plan's
// §5 hard constraint — browsers block scripted file-input assignment and mailto: can't carry
// attachments), so both flows end by queuing a pending action (see storage-schema.js) for Claude
// to resolve — no clipboard step, no manual paste.
(function () {
  const JH = self.JH || (self.JH = {});

  function parseMailto(linkUrl) {
    const withoutScheme = linkUrl.replace(/^mailto:/i, "");
    return decodeURIComponent(withoutScheme.split("?")[0]).trim();
  }

  function findAnchorTextForHref(linkUrl) {
    const anchors = Array.from(document.querySelectorAll(`a[href="${CSS.escape(linkUrl)}"]`));
    const withText = anchors.find((a) => a.textContent.trim().length > 0);
    return withText ? withText.textContent.trim() : "";
  }

  async function handleDraftEmail(linkUrl) {
    const recipient = parseMailto(linkUrl);
    const context = JH.scrapePageContext();
    const messageTemplate = await JH.getMessageTemplate();
    const resumeMeta = await JH.getResumeMeta();

    if (!messageTemplate) {
      JH.showToast("job-hunter: no message template saved yet — add one on the extension's options page.", {
        isError: true,
      });
      return;
    }
    if (!resumeMeta || !resumeMeta.mirroredPath) {
      JH.showToast("job-hunter: no resume uploaded yet — add one on the extension's options page.", {
        isError: true,
      });
      return;
    }

    const subject = JH.buildEmailSubject(context);
    const body = JH.fillTemplate(messageTemplate, context);

    await JH.queuePendingAction({
      type: "draft-email",
      url: location.href,
      recipient,
      subject,
      body,
      resumePath: resumeMeta.mirroredPath,
    });
    JH.showToast(`job-hunter: queued a draft-email to ${recipient} — Claude will pick this up next time you check in.`);
  }

  async function handleMessageProfile(linkUrl) {
    const guessedName = findAnchorTextForHref(linkUrl);
    const context = JH.scrapePageContext();
    const messageTemplate = await JH.getMessageTemplate();
    const resumeMeta = await JH.getResumeMeta();

    if (!messageTemplate) {
      JH.showToast("job-hunter: no message template saved yet — add one on the extension's options page.", {
        isError: true,
      });
      return;
    }
    if (!resumeMeta || !resumeMeta.mirroredPath) {
      JH.showToast("job-hunter: no resume uploaded yet — add one on the extension's options page.", {
        isError: true,
      });
      return;
    }

    const body = JH.fillTemplate(messageTemplate, {
      ...context,
      recruiter_name: guessedName || context.recruiter_name,
    });

    await JH.queuePendingAction({
      type: "message-profile",
      url: linkUrl,
      body,
      resumePath: resumeMeta.mirroredPath,
    });
    JH.showToast(`job-hunter: queued a LinkedIn DM with resume — Claude will pick this up next time you check in.`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "job-hunter:draft-email") {
      handleDraftEmail(message.linkUrl).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message && message.type === "job-hunter:message-profile") {
      handleMessageProfile(message.linkUrl).then(() => sendResponse({ ok: true }));
      return true;
    }
    return undefined;
  });
})();
