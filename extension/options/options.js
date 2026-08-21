(async function () {
  const JH = self.JH;

  // ---------------------------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------------------------

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  function setStatus(el, message, kind) {
    el.textContent = message;
    el.className = "status" + (kind ? ` ${kind}` : "");
    if (message) setTimeout(() => (el.textContent = ""), 5000);
  }

  function sendRuntimeMessage(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  /** Debounces `fn` per distinct `key` so concurrent fields don't cancel each other's saves. */
  function debounceByKey(fn, delay) {
    const timers = new Map();
    return (key, ...args) => {
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fn(key, ...args);
        }, delay)
      );
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Resume
  // ---------------------------------------------------------------------------------------------

  const resumeStatus = document.getElementById("resume-status");

  async function renderResumeMeta() {
    const meta = await JH.getResumeMeta();
    const emptyState = document.getElementById("resume-empty-state");
    const view = document.getElementById("resume-meta-view");
    if (!meta) {
      emptyState.hidden = false;
      view.hidden = true;
      return;
    }
    emptyState.hidden = true;
    view.hidden = false;
    document.getElementById("resume-filename").textContent = meta.fileName;
    document.getElementById("resume-uploaded-at").textContent = new Date(meta.uploadedAt).toLocaleString();
    document.getElementById("resume-size").textContent = `${Math.round(meta.sizeBytes / 1024)} KB`;
  }

  async function saveResumeFromArrayBuffer(arrayBuffer, fileName) {
    setStatus(resumeStatus, "Saving…");
    const response = await sendRuntimeMessage("job-hunter:save-resume", { arrayBuffer, fileName });
    if (response && response.ok) {
      setStatus(resumeStatus, "Resume saved.", "success");
      await renderResumeMeta();
    } else {
      setStatus(resumeStatus, `Failed: ${(response && response.error) || "unknown error"}`, "error");
    }
  }

  document.getElementById("resume-file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    await saveResumeFromArrayBuffer(arrayBuffer, file.name);
  });

  // ---------------------------------------------------------------------------------------------
  // Cover Letter
  // ---------------------------------------------------------------------------------------------

  const autoGenToggle = document.getElementById("auto-generate-toggle");

  async function initCoverLetterToggle() {
    const config = await JH.getConfig();
    autoGenToggle.checked = !!config.autoGenerateCoverLetter;
  }

  autoGenToggle.addEventListener("change", async () => {
    const config = await JH.getConfig();
    config.autoGenerateCoverLetter = autoGenToggle.checked;
    await JH.storageSet(JH.STORAGE_KEYS.CONFIG, config);
  });

  async function renderCoverLetterTable() {
    const index = await JH.getCoverLetterIndex();
    const rows = document.getElementById("cover-letter-rows");
    const empty = document.getElementById("cover-letter-empty");
    rows.innerHTML = "";

    const entries = Object.entries(index);
    empty.hidden = entries.length > 0;

    for (const [companySlug, entry] of entries) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = entry.companyDisplayName;

      const dateTd = document.createElement("td");
      dateTd.textContent = new Date(entry.generatedAt).toLocaleDateString();

      const actionsTd = document.createElement("td");

      const viewBtn = document.createElement("button");
      viewBtn.textContent = "View";
      viewBtn.addEventListener("click", async () => {
        const response = await sendRuntimeMessage("job-hunter:get-cover-letter", { companySlug });
        if (response && response.ok && response.payload) {
          alert(response.payload.plainText);
        }
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete the cached cover letter for ${entry.companyDisplayName}?`)) return;
        await sendRuntimeMessage("job-hunter:delete-cover-letter", { companySlug });
        await renderCoverLetterTable();
      });

      const regenBtn = document.createElement("button");
      regenBtn.textContent = "Regenerate";
      regenBtn.title = "Clears the cache — the next time a cover-letter field is filled for this company, a fresh one will be drafted.";
      regenBtn.addEventListener("click", async () => {
        await sendRuntimeMessage("job-hunter:delete-cover-letter", { companySlug });
        await renderCoverLetterTable();
      });

      actionsTd.append(viewBtn, regenBtn, deleteBtn);
      tr.append(nameTd, dateTd, actionsTd);
      rows.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Candidate Data — generic dotted-name / comma-list / JSON form (de)serialization
  // ---------------------------------------------------------------------------------------------

  const candidateForm = document.getElementById("candidate-data-form");
  const candidateStatus = document.getElementById("candidate-data-status");

  function setDeep(obj, path, value) {
    const parts = path.split(".");
    let node = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }

  function getDeep(obj, path) {
    return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), obj);
  }

  function populateForm(data) {
    if (!data) return;
    candidateForm.querySelectorAll("[name]").forEach((el) => {
      const raw = getDeep(data, el.name);
      if (raw === undefined) return;
      if (el.type === "checkbox") {
        el.checked = !!raw;
      } else if (el.dataset.json === "true") {
        el.value = JSON.stringify(raw, null, 2);
      } else if (el.dataset.list === "true") {
        const sep = el.dataset.listSep === "\\n" ? "\n" : ", ";
        el.value = Array.isArray(raw) ? raw.join(sep) : raw;
      } else {
        el.value = raw;
      }
    });
  }

  function serializeForm() {
    const data = {};
    candidateForm.querySelectorAll("[name]").forEach((el) => {
      if (el.type === "checkbox") {
        setDeep(data, el.name, el.checked);
        return;
      }
      if (el.dataset.json === "true") {
        if (!el.value.trim()) return;
        try {
          setDeep(data, el.name, JSON.parse(el.value));
        } catch (err) {
          throw new Error(`Invalid JSON in "${el.name}": ${err.message}`);
        }
        return;
      }
      if (el.dataset.list === "true") {
        const sep = el.dataset.listSep === "\\n" ? "\n" : ",";
        const list = el.value
          .split(sep)
          .map((s) => s.trim())
          .filter(Boolean);
        setDeep(data, el.name, list);
        return;
      }
      if (el.value !== "") setDeep(data, el.name, el.type === "number" ? Number(el.value) : el.value);
    });
    return data;
  }

  const autoSaveCandidateData = debounceByKey(async () => {
    try {
      const existing = (await JH.getCandidateData()) || {};
      const updates = serializeForm();
      const merged = { ...existing, ...updates };
      await JH.storageSet(JH.STORAGE_KEYS.CANDIDATE_DATA, merged);
      setStatus(candidateStatus, "Saved.", "success");
    } catch (err) {
      setStatus(candidateStatus, err.message, "error");
    }
  }, 600);

  candidateForm.addEventListener("input", () => autoSaveCandidateData("candidate-data"));
  candidateForm.addEventListener("change", () => autoSaveCandidateData("candidate-data"));

  // ---------------------------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------------------------

  const templatesStatus = document.getElementById("templates-status");
  const messageTemplateField = document.getElementById("message-template-body");

  function populateMessageTemplate(body) {
    messageTemplateField.value = body || "";
  }

  const autoSaveMessageTemplate = debounceByKey(async () => {
    await JH.storageSet(JH.STORAGE_KEYS.MESSAGE_TEMPLATE, messageTemplateField.value);
    setStatus(templatesStatus, "Saved.", "success");
  }, 600);

  messageTemplateField.addEventListener("input", () => autoSaveMessageTemplate("message-template"));

  // ---------------------------------------------------------------------------------------------
  // Pending — the "needs Claude" hand-off queue (see storage-schema.js's queuePendingAction).
  // ---------------------------------------------------------------------------------------------

  function describePendingAction(action) {
    switch (action.type) {
      case "draft-cover-letter":
        return `Draft a cover letter for ${action.companyDisplayName}`;
      case "draft-email":
        return `Draft an email to ${action.recipient}`;
      case "message-profile":
        return `Send a LinkedIn DM with resume attached`;
      default:
        return action.type;
    }
  }

  async function renderPendingTable() {
    const actions = await JH.getPendingActions();
    const rows = document.getElementById("pending-rows");
    const empty = document.getElementById("pending-empty");
    const badge = document.getElementById("pending-count-badge");
    rows.innerHTML = "";

    badge.textContent = actions.length > 0 ? `(${actions.length})` : "";
    empty.hidden = actions.length > 0;

    for (const action of actions) {
      const tr = document.createElement("tr");

      const typeTd = document.createElement("td");
      typeTd.textContent = describePendingAction(action);

      const whereTd = document.createElement("td");
      whereTd.textContent = action.url || "";
      whereTd.style.maxWidth = "260px";
      whereTd.style.overflow = "hidden";
      whereTd.style.textOverflow = "ellipsis";
      whereTd.style.whiteSpace = "nowrap";

      const whenTd = document.createElement("td");
      whenTd.textContent = new Date(action.createdAt).toLocaleString();

      const actionsTd = document.createElement("td");
      const dismissBtn = document.createElement("button");
      dismissBtn.textContent = "Dismiss";
      dismissBtn.addEventListener("click", async () => {
        await JH.removePendingAction(action.id);
        await renderPendingTable();
      });
      actionsTd.appendChild(dismissBtn);

      tr.append(typeTd, whereTd, whenTd, actionsTd);
      rows.appendChild(tr);
    }
  }

  // Keep the Pending tab (and its badge) and the Cover Letter table live while this page is
  // open, since Claude resolving items happens out-of-band from a separate tab/session.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[JH.STORAGE_KEYS.PENDING_ACTIONS]) renderPendingTable();
    if (changes[JH.STORAGE_KEYS.COVER_LETTER_INDEX]) renderCoverLetterTable();
    if (
      changes[JH.STORAGE_KEYS.CATEGORY_ALIAS_OVERRIDES] ||
      changes[JH.STORAGE_KEYS.CUSTOM_CATEGORIES] ||
      changes[JH.STORAGE_KEYS.CUSTOM_CANDIDATE_FIELDS]
    ) {
      renderCategoryTable();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Field Categories — bulk review/edit of the local, zero-AI autofill dictionary. The on-page
  // "unrecognized field" modal only handles one field at a time; this tab is for reviewing and
  // hand-tuning everything at once.
  // ---------------------------------------------------------------------------------------------

  const categoryStatus = document.getElementById("category-status");

  const autoSaveCategoryAliases = debounceByKey(async (category, inputEl) => {
    const dictionary = await JH.getEffectiveCategoryDictionary();
    const existing = new Set(dictionary.aliases[category] || []);
    const edited = inputEl.value
      .split(",")
      .map((s) => JH.normalizeText(s))
      .filter(Boolean);

    // Additive only: aliases are stored as "extra on top of the shipped defaults" (see
    // storage-schema.js), so a shipped default can't be removed here — only new ones added.
    const toAdd = edited.filter((a) => !existing.has(a));
    for (const alias of toAdd) {
      if (dictionary.custom[category]) {
        const custom = await JH.storageGet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, {});
        custom[category].aliases = [...new Set([...(custom[category].aliases || []), alias])];
        await JH.storageSet(JH.STORAGE_KEYS.CUSTOM_CATEGORIES, custom);
      } else {
        await JH.addCategoryAlias(category, alias);
      }
    }
  }, 600);

  async function renderCategoryTable() {
    const dictionary = await JH.getEffectiveCategoryDictionary();
    const candidateData = await JH.getCandidateData();
    const rows = document.getElementById("category-rows");
    rows.innerHTML = "";

    const categories = Object.keys(dictionary.aliases).sort();
    for (const category of categories) {
      const isCustom = !!dictionary.custom[category];
      const value = await JH.resolveCategoryValue(category, candidateData, dictionary);
      const valuePreview = value === "__ATTACHMENT__" ? "(file attachment)" : value === undefined || value === "" ? "—" : String(value).slice(0, 40);

      const tr = document.createElement("tr");

      const catTd = document.createElement("td");
      catTd.textContent = category;

      const sourceTd = document.createElement("td");
      sourceTd.textContent = isCustom ? "custom" : "built-in";

      const valueTd = document.createElement("td");
      valueTd.textContent = valuePreview;
      valueTd.style.color = "var(--text-muted)";
      valueTd.style.fontSize = "12px";

      const aliasTd = document.createElement("td");
      const aliasInput = document.createElement("input");
      aliasInput.type = "text";
      aliasInput.value = dictionary.aliases[category].join(", ");
      aliasInput.style.width = "100%";
      aliasInput.addEventListener("input", () => autoSaveCategoryAliases(category, aliasInput));
      aliasTd.appendChild(aliasInput);

      const actionsTd = document.createElement("td");
      if (isCustom) {
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
          if (!confirm(`Delete the custom category "${category}"?`)) return;
          await JH.deleteCustomCategory(category);
          await renderCategoryTable();
        });
        actionsTd.appendChild(deleteBtn);
      }

      tr.append(catTd, sourceTd, valueTd, aliasTd, actionsTd);
      rows.appendChild(tr);
    }
  }

  const addCategoryToggle = document.getElementById("add-category-toggle");
  const addCategoryForm = document.getElementById("add-category-form");
  addCategoryToggle.addEventListener("click", () => {
    addCategoryForm.hidden = !addCategoryForm.hidden;
  });

  document.getElementById("add-category-submit").addEventListener("click", async () => {
    const idInput = document.getElementById("new-category-id");
    const valueInput = document.getElementById("new-category-value");
    const aliasInput = document.getElementById("new-category-alias");
    const id = idInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_+|_+$)/g, "");
    const value = valueInput.value.trim();
    if (!id || !value) {
      setStatus(categoryStatus, "Category id and value are both required.", "error");
      return;
    }
    await JH.addCustomCategory(id, value, aliasInput.value.trim() || id);
    idInput.value = "";
    valueInput.value = "";
    aliasInput.value = "";
    addCategoryForm.hidden = true;
    setStatus(categoryStatus, "Category added.", "success");
    await renderCategoryTable();
  });

  // ---------------------------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------------------------

  await renderResumeMeta();
  await initCoverLetterToggle();
  await renderCoverLetterTable();
  await renderPendingTable();
  await renderCategoryTable();
  populateForm(await JH.getCandidateData());
  populateMessageTemplate(await JH.getMessageTemplate());
})();
