// Shared storage constants + thin helpers, loaded as a classic script everywhere
// (background via importScripts, content scripts + options page via <script>/manifest js[]).
// Everything hangs off self.JH so no module system is needed anywhere in the extension.
(function () {
  const JH = self.JH || (self.JH = {});

  JH.STORAGE_KEYS = Object.freeze({
    CONFIG: "config",
    CANDIDATE_DATA: "candidateData",
    MESSAGE_TEMPLATE: "messageTemplate",
    RESUME_META: "resumeMeta",
    COVER_LETTER_INDEX: "coverLetterIndex",
    PENDING_ACTIONS: "pendingActions",
    PROCESSING_STATUS: "processingStatus",
    // category-matching autofill (see shared/field-categories.js)
    CATEGORY_ALIAS_OVERRIDES: "categoryAliasOverrides",
    CUSTOM_CATEGORIES: "customCategories",
    CUSTOM_CANDIDATE_FIELDS: "customCandidateFields",
    IGNORED_FIELD_SIGNATURES: "ignoredFieldSignatures",
  });

  JH.DEFAULT_CONFIG = Object.freeze({
    autoGenerateCoverLetter: false,
    javaHighlightEnabled: true,
  });

  JH.DB_NAME = "JobHunterDB";
  JH.DB_VERSION = 1;
  JH.STORE_RESUME_BLOB = "resumeBlob";
  JH.STORE_COVER_LETTERS = "coverLetters";

  /** chrome.storage.local.get for a single key, promise-based, with a default fallback. */
  JH.storageGet = function storageGet(key, fallback) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] === undefined ? fallback : result[key]);
      });
    });
  };

  /** chrome.storage.local.set for a single key, promise-based. */
  JH.storageSet = function storageSet(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  };

  JH.getConfig = async function getConfig() {
    const stored = await JH.storageGet(JH.STORAGE_KEYS.CONFIG, null);
    return { ...JH.DEFAULT_CONFIG, ...(stored || {}) };
  };

  JH.getCandidateData = function getCandidateData() {
    return JH.storageGet(JH.STORAGE_KEYS.CANDIDATE_DATA, null);
  };

  /** The single shared message template (used for both email and LinkedIn DM bodies). */
  JH.getMessageTemplate = function getMessageTemplate() {
    return JH.storageGet(JH.STORAGE_KEYS.MESSAGE_TEMPLATE, "");
  };

  /** Deterministic email subject — never user-edited, always derived from page context. */
  JH.buildEmailSubject = function buildEmailSubject(context) {
    return JH.fillTemplate("Application | {{role_title}}", context);
  };

  JH.getResumeMeta = function getResumeMeta() {
    return JH.storageGet(JH.STORAGE_KEYS.RESUME_META, null);
  };

  JH.getCoverLetterIndex = function getCoverLetterIndex() {
    return JH.storageGet(JH.STORAGE_KEYS.COVER_LETTER_INDEX, {});
  };

  // -----------------------------------------------------------------------------------------
  // Pending actions — the "needs Claude" hand-off queue. Content scripts (which always run in
  // the extension's own isolated world, never in an untrusted page's JS context) write directly
  // here; nothing about this queue is ever exposed to page-authored code. Claude resolves items
  // via content/agent-bridge.js — a postMessage relay it can reach from *any* regular page (since
  // browser-automation tools can't navigate to chrome-extension:// URLs), no clipboard step.
  // -----------------------------------------------------------------------------------------

  JH.getPendingActions = function getPendingActions() {
    return JH.storageGet(JH.STORAGE_KEYS.PENDING_ACTIONS, []);
  };

  /** Queues one action for Claude to resolve. Returns the queued record (with a generated id). */
  JH.queuePendingAction = async function queuePendingAction(action) {
    const actions = await JH.getPendingActions();
    const record = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      createdAt: new Date().toISOString(),
      ...action,
    };
    actions.push(record);
    await JH.storageSet(JH.STORAGE_KEYS.PENDING_ACTIONS, actions);
    return record;
  };

  JH.removePendingAction = async function removePendingAction(id) {
    const actions = await JH.getPendingActions();
    await JH.storageSet(
      JH.STORAGE_KEYS.PENDING_ACTIONS,
      actions.filter((a) => a.id !== id)
    );
  };

  /**
   * Live progress broadcast while Claude is actively resolving a pending item. `url` scopes the
   * update to the one tab actually being worked on — content scripts on other tabs ignore it.
   */
  JH.setProcessingStatus = function setProcessingStatus({ url, message, kind }) {
    return JH.storageSet(JH.STORAGE_KEYS.PROCESSING_STATUS, {
      url,
      message,
      kind: kind || "info",
      updatedAt: new Date().toISOString(),
    });
  };

  /**
   * Flattens candidateData's scalar leaf fields into dotted-path keys (e.g. "contact.email")
   * so a saved selector map's logicalName can address them directly. Arrays/nested lists
   * (skills, experience, education, ...) aren't flattened here since they don't map onto a
   * single form field — a field with no matching key here is simply left unfilled, which is
   * the deliberate behavior for EEO/demographic questions with no corresponding candidate data.
   */
  JH.flattenCandidateData = function flattenCandidateData(candidateData, prefix = "") {
    const out = {};
    if (!candidateData || typeof candidateData !== "object") return out;
    for (const [key, value] of Object.entries(candidateData)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) continue;
      if (typeof value === "object") {
        Object.assign(out, JH.flattenCandidateData(value, path));
      } else {
        out[path] = value;
      }
    }
    // Derived phone parts (top-level call only) — a masked phone widget's country-picker and
    // local-digits input are usually two separate fields, neither of which wants the raw
    // "+55 21 98226-9642" string as-is.
    if (!prefix && candidateData.contact && candidateData.contact.phone) {
      const { countryName, localDigits } = JH.derivePhoneParts(candidateData.contact.phone);
      if (countryName) out["contact.phone_country_name"] = countryName;
      if (localDigits) out["contact.phone_local_digits"] = localDigits;
    }
    return out;
  };

  const CALLING_CODE_COUNTRY = {
    1: "United States",
    55: "Brasil",
    44: "United Kingdom",
    351: "Portugal",
    34: "Spain",
    49: "Germany",
  };

  /** "+55 21 98226-9642" -> { countryName: "Brasil", localDigits: "21982269642" }. */
  JH.derivePhoneParts = function derivePhoneParts(rawPhone) {
    const digits = String(rawPhone || "").replace(/\D/g, "");
    for (const len of [3, 2, 1]) {
      const code = digits.slice(0, len);
      if (CALLING_CODE_COUNTRY[code]) {
        return { countryName: CALLING_CODE_COUNTRY[code], localDigits: digits.slice(len) };
      }
    }
    return { countryName: null, localDigits: digits };
  };

  // -----------------------------------------------------------------------------------------
  // Category-matching autofill — see shared/field-categories.js for the matching engine and the
  // shipped DEFAULT_CATEGORY_REFS/DEFAULT_CATEGORY_ALIASES dictionaries. User edits (new aliases,
  // custom categories) are layered on top here, in chrome.storage.local, so they survive an
  // extension update overwriting the shipped defaults.
  // -----------------------------------------------------------------------------------------

  /** Shipped defaults + any user-added aliases/custom categories, merged into one dictionary. */
  JH.getEffectiveCategoryDictionary = async function getEffectiveCategoryDictionary() {
    const [overrides, custom] = await Promise.all([
      JH.storageGet(JH.STORAGE_KEYS.CATEGORY_ALIAS_OVERRIDES, {}),
      JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, {}),
    ]);
    const aliases = { ...JH.DEFAULT_CATEGORY_ALIASES };
    for (const [cat, extra] of Object.entries(overrides)) {
      aliases[cat] = [...new Set([...(aliases[cat] || []), ...extra])];
    }
    for (const [cat, def] of Object.entries(custom)) {
      aliases[cat] = [...new Set([...(aliases[cat] || []), ...(def.aliases || [])])];
    }
    const refs = { ...JH.DEFAULT_CATEGORY_REFS };
    for (const [cat, def] of Object.entries(custom)) refs[cat] = def.ref;
    return { aliases, refs, custom };
  };

  /**
   * Resolves a matched category to an actual value: a derivation function, a lookup into the
   * flat custom-fields bucket, a file-attachment sentinel, or a dotted-path lookup into the
   * existing (nested) candidateData object — one code path for both built-in and user-added
   * categories, since custom ones are just another "ref" shape.
   */
  JH.resolveCategoryValue = async function resolveCategoryValue(category, candidateData, dictionary) {
    const ref = dictionary.refs[category];
    if (!ref) return undefined;
    if (ref.startsWith("derived:")) {
      const fn = JH.CATEGORY_DERIVATIONS[ref.slice(8)];
      return fn ? fn(candidateData) : undefined;
    }
    if (ref.startsWith("custom:")) {
      const customFields = await JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CANDIDATE_FIELDS, {});
      return customFields[ref.slice(7)];
    }
    if (ref === "file:resume") {
      const meta = await JH.getResumeMeta();
      return meta ? "__ATTACHMENT__" : undefined;
    }
    if (ref === "file:cover_letter") return "__ATTACHMENT__";
    return ref.split(".").reduce((node, key) => (node == null ? undefined : node[key]), candidateData);
  };

  /** Teaches an existing category a new alias (from the modal's "link to existing" path). */
  JH.addCategoryAlias = async function addCategoryAlias(category, rawLabel) {
    const overrides = await JH.storageGet(JH.STORAGE_KEYS.CATEGORY_ALIAS_OVERRIDES, {});
    const normalized = JH.normalizeText(rawLabel);
    overrides[category] = [...new Set([...(overrides[category] || []), normalized])];
    await JH.storageSet(JH.STORAGE_KEYS.CATEGORY_ALIAS_OVERRIDES, overrides);
  };

  /** Creates a brand-new category backed by the flat custom-fields bucket (the modal's "new category" path). */
  JH.addCustomCategory = async function addCustomCategory(id, value, firstAliasRawLabel) {
    const [fields, custom] = await Promise.all([
      JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CANDIDATE_FIELDS, {}),
      JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, {}),
    ]);
    fields[id] = value;
    custom[id] = { ref: `custom:${id}`, aliases: [JH.normalizeText(firstAliasRawLabel)] };
    await Promise.all([
      JH.storageSet(JH.STORAGE_KEYS.CUSTOM_CANDIDATE_FIELDS, fields),
      JH.storageSet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, custom),
    ]);
  };

  JH.deleteCustomCategory = async function deleteCustomCategory(id) {
    const [fields, custom] = await Promise.all([
      JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CANDIDATE_FIELDS, {}),
      JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, {}),
    ]);
    delete fields[id];
    delete custom[id];
    await Promise.all([
      JH.storageSet(JH.STORAGE_KEYS.CUSTOM_CANDIDATE_FIELDS, fields),
      JH.storageSet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, custom),
    ]);
  };

  /** Marks one field (by its normalized label, scoped per-origin) as "don't ask again". */
  JH.addIgnoredFieldSignature = async function addIgnoredFieldSignature(origin, signature) {
    const ignored = await JH.storageGet(JH.STORAGE_KEYS.IGNORED_FIELD_SIGNATURES, {});
    ignored[`${origin}::${signature.labelText}`] = true;
    await JH.storageSet(JH.STORAGE_KEYS.IGNORED_FIELD_SIGNATURES, ignored);
  };

  /** Filters out previously-ignored fields (by origin + normalized label) from an unmatched list. */
  JH.filterIgnored = async function filterIgnored(unmatchedFields, origin) {
    const ignored = await JH.storageGet(JH.STORAGE_KEYS.IGNORED_FIELD_SIGNATURES, {});
    return unmatchedFields.filter((f) => !ignored[`${origin}::${f.signature.labelText}`]);
  };

  /** company display name -> a stable, storage-safe slug key. */
  JH.slugifyCompany = function slugifyCompany(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "unknown-company";
  };
})();
