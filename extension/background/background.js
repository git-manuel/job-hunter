// Classic (non-module) service worker — importScripts is the simplest way to share code with
// the content scripts/options page without wiring up ES module import maps inside an extension.
importScripts(
  "../shared/storage-schema.js",
  "../shared/template-engine.js",
  "../vendor/jspdf.umd.min.js"
);

const JH = self.JH;

// ---------------------------------------------------------------------------------------------
// IndexedDB — background.js is the *only* context that opens this database, so options page and
// content scripts always go through runtime messages for anything blob-related. This avoids
// version-upgrade races between multiple contexts opening the same DB concurrently.
// ---------------------------------------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(JH.DB_NAME, JH.DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JH.STORE_RESUME_BLOB)) {
        db.createObjectStore(JH.STORE_RESUME_BLOB, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(JH.STORE_COVER_LETTERS)) {
        db.createObjectStore(JH.STORE_COVER_LETTERS, { keyPath: "companySlug" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function idbPut(storeName, record) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbGet(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      })
  );
}

function idbDelete(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// ---------------------------------------------------------------------------------------------
// Disk mirror — mcp__claude-in-chrome__file_upload needs a real absolute filesystem path, not a
// blob, so every stored blob is mirrored to disk via chrome.downloads and the resolved path is
// what gets handed to Claude.
// ---------------------------------------------------------------------------------------------

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function mirrorBlobToDisk(blob, relativePath) {
  const url = await blobToDataUrl(blob);
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: `job-hunter/${relativePath}`, conflictAction: "overwrite", saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      }
    );
  });

  // download() only confirms the download *started* — filename isn't reliably populated until
  // it actually finishes writing to disk. Wait for that, rather than reading it immediately
  // (which raced ahead of the write and returned an empty path).
  return new Promise((resolve, reject) => {
    function finish(item) {
      chrome.downloads.onChanged.removeListener(onChanged);
      if (item.state === "complete") resolve(item.filename);
      else reject(new Error(`download did not complete (state: ${item.state})`));
    }
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        chrome.downloads.search({ id: downloadId }, ([item]) => finish(item || { state: "interrupted" }));
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
    // Also check immediately in case it already finished before this listener attached.
    chrome.downloads.search({ id: downloadId }, ([item]) => {
      if (item && item.state === "complete") finish(item);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Auto-seed — populates candidate data / message template / resume from the bundled seed files
// the first time the extension runs, so there's no manual "import seed" button anywhere. Every
// check is idempotent (only fills in what's actually missing), so it's safe to re-run on every
// onInstalled firing (install, update, and — during development — most "Reload" clicks).
// ---------------------------------------------------------------------------------------------

// Fetching a bundled chrome-extension:// resource only works unconditionally from here
// (background) — content scripts (agent-bridge.js) can't do it without a web_accessible_resources
// manifest entry, which this deliberately avoids adding (that would make the resume PDF fetchable
// by any page that knows the extension id). This is also what fixes a stuck-empty resumeMeta.mirroredPath
// (see the chrome.downloads race condition note below) — it's safe to call again even when a
// resumeMeta record already exists, unlike the auto-seed check below which only runs once.
async function seedResumeFromBundle() {
  const response = await fetch(chrome.runtime.getURL("seed/Manuel_Almeida_Resume.pdf"));
  const arrayBuffer = await response.arrayBuffer();
  return handleSaveResume({ arrayBuffer, fileName: "Manuel_Almeida_Resume.pdf" });
}

async function seedInitialDataIfMissing() {
  const candidateData = await JH.getCandidateData();
  if (!candidateData) {
    const response = await fetch(chrome.runtime.getURL("seed/candidate-data.seed.json"));
    await JH.storageSet(JH.STORAGE_KEYS.CANDIDATE_DATA, await response.json());
  }

  const messageTemplate = await JH.getMessageTemplate();
  if (!messageTemplate) {
    const response = await fetch(chrome.runtime.getURL("seed/message-template.seed.json"));
    const seed = await response.json();
    await JH.storageSet(JH.STORAGE_KEYS.MESSAGE_TEMPLATE, seed.body || "");
  }

  const resumeMeta = await JH.getResumeMeta();
  if (!resumeMeta) await seedResumeFromBundle();
}

// ---------------------------------------------------------------------------------------------
// Toolbar icon — no popup declared, so this fires on every click. Opens the options page (a
// privileged chrome-extension:// origin), which is also how Claude discovers this extension's
// id when asked to process the pending-actions queue: navigate here once, read the tab's URL.
// ---------------------------------------------------------------------------------------------

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  seedInitialDataIfMissing();

  chrome.contextMenus.create({
    id: "job-hunter-draft-email",
    title: "JH - Draft email with resume",
    contexts: ["link"],
  });
  chrome.contextMenus.create({
    id: "job-hunter-message-profile",
    title: "JH - Message with resume",
    contexts: ["link"],
    targetUrlPatterns: ["*://*.linkedin.com/in/*"],
  });
});

// Content scripts only exist in tabs that loaded *after* the extension did — a tab left open
// from before an install/reload, or a chrome://* / Web Store page, has no listener at all. The
// callback form (rather than the Promise form) lets us read chrome.runtime.lastError ourselves
// instead of leaving an unhandled rejection that Chrome surfaces as a scary red error.
function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      console.warn(
        "[job-hunter] no content script listening on this tab — reload the page and try again:",
        chrome.runtime.lastError.message
      );
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === "job-hunter-draft-email") {
    if (!info.linkUrl || !info.linkUrl.toLowerCase().startsWith("mailto:")) return;
    sendToTab(tab.id, { type: "job-hunter:draft-email", linkUrl: info.linkUrl });
    return;
  }

  if (info.menuItemId === "job-hunter-message-profile") {
    if (!info.linkUrl || !/linkedin\.com\/in\//i.test(info.linkUrl)) return;
    sendToTab(tab.id, { type: "job-hunter:message-profile", linkUrl: info.linkUrl });
  }
});

// F9 (or whatever the user rebinds it to in chrome://extensions/shortcuts) triggers the same
// auto-complete message as the context-menu item, on whichever tab is currently focused.
chrome.commands.onCommand.addListener((command) => {
  console.log("[job-hunter] command received:", command);
  if (command !== "auto-complete") return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    console.log("[job-hunter] dispatching to tab:", tab && tab.id, tab && tab.url);
    if (tab && tab.id) sendToTab(tab.id, { type: "job-hunter:auto-complete" });
  });
});

// Fires once per service-worker startup — proves the listener above actually got registered at
// all (as opposed to registering successfully but chrome.commands never invoking it).
chrome.commands.getAll((commands) => {
  console.log("[job-hunter] registered commands:", commands);
});

// ---------------------------------------------------------------------------------------------
// Runtime message handlers — anything content scripts/options page can't do directly because it
// touches IndexedDB (single-writer discipline) or needs jsPDF/chrome.downloads.
// ---------------------------------------------------------------------------------------------

async function handleSaveResume({ arrayBuffer, fileName }) {
  const blob = new Blob([arrayBuffer], { type: "application/pdf" });
  await idbPut(JH.STORE_RESUME_BLOB, { id: "current", blob, fileName, uploadedAt: new Date().toISOString() });
  const mirroredPath = await mirrorBlobToDisk(blob, "current-resume.pdf");
  const meta = {
    fileName,
    uploadedAt: new Date().toISOString(),
    sizeBytes: arrayBuffer.byteLength,
    mirroredPath,
    mirroredAt: new Date().toISOString(),
  };
  await JH.storageSet(JH.STORAGE_KEYS.RESUME_META, meta);
  return meta;
}

async function handleSaveCoverLetter({ companySlug, companyDisplayName, plainText, sourceJobUrl }) {
  if (!companySlug || !plainText) throw new Error("companySlug and plainText are required");

  const candidateData = await JH.getCandidateData();
  const contact = (candidateData && candidateData.contact) || {};

  const doc = new self.jspdf.jsPDF({ unit: "pt", format: "letter" });
  const marginX = 56;
  let y = 72;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(contact.full_name || "", marginX, y);
  y += 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const contactLine = [contact.email, contact.phone, contact.location].filter(Boolean).join("  |  ");
  doc.text(contactLine, marginX, y);
  y += 28;

  doc.setFontSize(11);
  const wrapped = doc.splitTextToSize(plainText, 500);
  doc.text(wrapped, marginX, y);

  const pdfBlob = doc.output("blob");

  const mirroredPath = await mirrorBlobToDisk(pdfBlob, `cover-letters/${companySlug}.pdf`);
  const record = {
    companySlug,
    companyDisplayName: companyDisplayName || companySlug,
    generatedAt: new Date().toISOString(),
    plainText,
    pdfBlob,
    mirroredPath,
    sourceJobUrl: sourceJobUrl || "",
  };
  await idbPut(JH.STORE_COVER_LETTERS, record);

  const index = await JH.getCoverLetterIndex();
  index[companySlug] = {
    companyDisplayName: record.companyDisplayName,
    generatedAt: record.generatedAt,
    mirroredPath,
  };
  await JH.storageSet(JH.STORAGE_KEYS.COVER_LETTER_INDEX, index);

  return { saved: true, mirroredPath, companySlug };
}

// Lets Claude fetch the resume as base64 straight from IndexedDB via agent-bridge.js's generic
// relay-to-background passthrough — no local filesystem/Bash access needed, so a browser-only
// session (e.g. a claude.ai tab with the Claude in Chrome extension, no Bash tool at all) can
// still attach the resume to an email, instead of depending on the chrome.downloads-mirrored path.
async function handleGetResumeBase64() {
  const record = await idbGet(JH.STORE_RESUME_BLOB, "current");
  if (!record) throw new Error("no resume uploaded yet");
  const dataUrl = await blobToDataUrl(record.blob);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64, fileName: record.fileName, mimeType: record.blob.type || "application/pdf" };
}

async function handleGetCoverLetter({ companySlug }) {
  const record = await idbGet(JH.STORE_COVER_LETTERS, companySlug);
  if (!record) return null;
  return {
    companySlug: record.companySlug,
    companyDisplayName: record.companyDisplayName,
    generatedAt: record.generatedAt,
    plainText: record.plainText,
    mirroredPath: record.mirroredPath,
    sourceJobUrl: record.sourceJobUrl,
  };
}

async function handleDeleteCoverLetter({ companySlug }) {
  await idbDelete(JH.STORE_COVER_LETTERS, companySlug);
  const index = await JH.getCoverLetterIndex();
  delete index[companySlug];
  await JH.storageSet(JH.STORAGE_KEYS.COVER_LETTER_INDEX, index);
  return { deleted: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  const handlers = {
    "job-hunter:save-resume": () => handleSaveResume(message.payload),
    "job-hunter:reseed-resume": () => seedResumeFromBundle(),
    "job-hunter:get-resume-base64": () => handleGetResumeBase64(),
    "job-hunter:save-cover-letter": () => handleSaveCoverLetter(message.payload),
    "job-hunter:get-cover-letter": () => handleGetCoverLetter(message.payload),
    "job-hunter:delete-cover-letter": () => handleDeleteCoverLetter(message.payload),
  };

  const handler = handlers[message.type];
  if (!handler) return undefined;

  handler()
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response
});
