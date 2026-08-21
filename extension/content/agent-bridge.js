// Lets Claude (executing JS in a page's main world via a browser-automation tool) reach this
// extension's storage from whatever page it's currently on, instead of needing to navigate to
// the extension's own chrome-extension:// options page (which browser-automation tools can't
// reach — chrome-extension:// URLs get mangled by URL-normalization logic that assumes http(s)).
//
// No token here (unlike the old bridge.js, removed earlier this project): pendingActions is only
// ever written by this trusted content script, never by page code, so there's nothing for a page
// script to spoof into existence — the worst a malicious page script sharing this channel name
// could do is read state that content script already has direct access to on this same page
// anyway. Scoped to same-window messages only (no cross-frame relay).
(function () {
  const JH = self.JH || (self.JH = {});
  const CHANNEL = "job-hunter-agent-bridge";

  function respond(requestId, ok, payload, error) {
    window.postMessage(
      { channel: CHANNEL, direction: "response", requestId, ok, error, payload },
      window.location.origin
    );
  }

  async function handleRequest(msg) {
    const { requestId, action, payload } = msg;
    try {
      switch (action) {
        case "get-state": {
          const [pendingActions, candidateData, resumeMeta, messageTemplate, coverLetterIndex, categoryDictionary] =
            await Promise.all([
              JH.getPendingActions(),
              JH.getCandidateData(),
              JH.getResumeMeta(),
              JH.getMessageTemplate(),
              JH.getCoverLetterIndex(),
              JH.getEffectiveCategoryDictionary(),
            ]);
          return respond(requestId, true, {
            pendingActions,
            candidateData,
            resumeMeta,
            messageTemplate,
            coverLetterIndex,
            categoryDictionary,
          });
        }
        case "remove-pending-action": {
          if (!payload || !payload.id) return respond(requestId, false, null, "missing id");
          await JH.removePendingAction(payload.id);
          return respond(requestId, true, {});
        }
        case "set-processing-status": {
          await JH.setProcessingStatus(payload || {});
          return respond(requestId, true, {});
        }
        case "set-candidate-data-path": {
          // Generic dotted-path write into candidateData (mirrors the dotted-path *read* already
          // used by resolveCategoryValue in storage-schema.js) — lets Claude correct a stored
          // field (e.g. reformatting a phone number) without needing a new bridge action per field
          // or asking the user to retype it on the options page.
          const { path, value } = payload || {};
          if (!path) return respond(requestId, false, null, "missing path");
          const candidateData = (await JH.getCandidateData()) || {};
          const keys = path.split(".");
          let node = candidateData;
          for (let i = 0; i < keys.length - 1; i++) {
            if (typeof node[keys[i]] !== "object" || node[keys[i]] === null) node[keys[i]] = {};
            node = node[keys[i]];
          }
          node[keys[keys.length - 1]] = value;
          await JH.storageSet(JH.STORAGE_KEYS.CANDIDATE_DATA, candidateData);
          return respond(requestId, true, { path, value });
        }
        case "reseed-resume": {
          // Re-runs the bundled-resume save through background.js's (now-fixed) mirrorBlobToDisk,
          // for records that were auto-seeded before that fix and are stuck with an empty path.
          // Relayed to background.js — it must do the actual fetch of the bundled PDF itself:
          // a content script fetching a chrome-extension:// resource needs it declared in
          // web_accessible_resources (which this deliberately doesn't add, to avoid making the
          // resume PDF fetchable by any page that knows the extension id), but background has no
          // such restriction fetching its own bundled resources.
          const saveResponse = await chrome.runtime.sendMessage({ type: "job-hunter:reseed-resume" });
          return respond(
            requestId,
            !!(saveResponse && saveResponse.ok),
            saveResponse && saveResponse.payload,
            saveResponse && saveResponse.error
          );
        }
        case "run-auto-complete": {
          // Debug/test hook — see the comment on JH.runAutoComplete in autofill-engine.js. Lets
          // Claude trigger the real fill flow from any page without the Ctrl+Shift+U shortcut,
          // which browser-automation tools can't dispatch.
          if (typeof JH.runAutoComplete !== "function") {
            return respond(requestId, false, null, "JH.runAutoComplete not loaded — is autofill-engine.js injected on this page?");
          }
          await JH.runAutoComplete();
          return respond(requestId, true, {});
        }
        case "relay-to-background": {
          // Generic passthrough to background.js's chrome.runtime.onMessage handlers (see
          // background.js) — covers save-resume, save-cover-letter, get-cover-letter,
          // delete-cover-letter, and any future ones, without needing a new case here each time.
          // Page main-world JS has no chrome.runtime access, so this content script does the
          // actual chrome.runtime.sendMessage call on Claude's behalf.
          const { messageType, messagePayload } = payload || {};
          const response = await chrome.runtime.sendMessage({ type: messageType, payload: messagePayload });
          return respond(
            requestId,
            !!(response && response.ok),
            response && response.payload,
            response && response.error
          );
        }
        default:
          return respond(requestId, false, null, `unknown action: ${action}`);
      }
    } catch (err) {
      const detail = err && err.stack ? err.stack : String((err && err.message) || err);
      return respond(requestId, false, null, detail);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== "request") return;
    handleRequest(msg);
  });
})();
