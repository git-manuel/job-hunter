// In-page modal shown when a scanned field doesn't match any known category. Never routes to
// Claude — this is the local, human-in-the-loop resolution path the user asked for instead of an
// AI hand-off. Injected fresh each time (no persistent DOM), styled via category-modal.css
// (loaded through manifest.json's content_scripts "css" array).
(function () {
  const JH = self.JH || (self.JH = {});

  function escapeHtml(s) {
    return String(s || "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function previewValue(value) {
    if (value === undefined || value === null || value === "") return "(no value set)";
    if (value === "__ATTACHMENT__") return "(file attachment)";
    return String(value).slice(0, 40);
  }

  // Modern build tooling (emotion/styled-components, CSS modules) generates class tokens like
  // "css-jpob98" or "e1dutdso0" that carry zero human meaning — filtering those out leaves only
  // genuinely descriptive tokens like "react-dropdown-select" or "PhoneInputInput" when present.
  function meaningfulClassTokens(className) {
    return String(className || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => t !== "undefined" && t !== "null")
      .filter((t) => !/^css-[a-z0-9]+$/i.test(t))
      .filter((t) => !/^e[0-9][a-z0-9]{4,}$/i.test(t))
      .slice(0, 2);
  }

  // rawLabel is often a DOM-proximity guess (see field-scanner.js's nearestPrecedingText
  // fallback) and can be misleading text unrelated to the actual field — this is a second,
  // unambiguous identifier built from the element's own attributes instead of nearby page text.
  // Preference order: id/name/placeholder (clean, purpose-built attributes) before falling back
  // to a filtered class name, which is noisier and only used when nothing cleaner is available.
  // aria-label is deliberately skipped here — it's already rawLabel's top priority, so it's shown
  // in the header above and repeating it here would be redundant.
  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const type = el.type && el.tagName === "INPUT" ? ` type="${el.type}"` : "";
    const idAttr = el.id ? ` id="${el.id}"` : "";
    const nameAttr = el.name ? ` name="${el.name}"` : "";
    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    const placeholderAttr = placeholder ? ` placeholder="${placeholder}"` : "";
    const hasCleanAttr = idAttr || nameAttr || placeholderAttr;
    const classTokens = hasCleanAttr ? [] : meaningfulClassTokens(el.className);
    const clsAttr = classTokens.length ? ` class="${classTokens.join(" ")}"` : "";
    return `<${tag}${type}${idAttr}${nameAttr}${placeholderAttr}${clsAttr}>`;
  }

  /**
   * Shows the modal for one unmatched field. Resolves to:
   * - {action:"linked", category}  — user picked an existing category; it now has a new alias
   * - {action:"created", category} — user defined a brand-new category
   * - {action:"ignored"}           — user asked never to be prompted for this field again (persisted)
   * - {action:"dismissed"}         — user closed the modal without deciding (not persisted, will re-prompt)
   */
  JH.showCategoryModal = function showCategoryModal(fieldInfo, dictionary, candidateData) {
    return new Promise((resolve) => {
      const previous = document.getElementById("jh-cm-overlay");
      if (previous) previous.remove();

      let settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        overlay.remove();
        resolve(result);
      }

      const overlay = document.createElement("div");
      overlay.id = "jh-cm-overlay";
      overlay.className = "jh-cm-overlay";
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) finish({ action: "dismissed" });
      });

      const box = document.createElement("div");
      box.className = "jh-cm-box";
      overlay.appendChild(box);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "jh-cm-close";
      closeBtn.textContent = "×";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.addEventListener("click", () => finish({ action: "dismissed" }));
      box.appendChild(closeBtn);

      const header = document.createElement("div");
      header.className = "jh-cm-header";
      header.innerHTML =
        '<p class="jh-cm-eyebrow">job-hunter — unrecognized field</p>' +
        `<p class="jh-cm-label">${escapeHtml(fieldInfo.signature.rawLabel || "(no label found)")}</p>` +
        `<p class="jh-cm-technical">${escapeHtml(describeElement(fieldInfo.element))}</p>`;
      box.appendChild(header);

      // ---- link to an existing category (live search) ----
      const searchWrap = document.createElement("div");
      searchWrap.className = "jh-cm-section";
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.placeholder = "Search categories…";
      searchInput.className = "jh-cm-search";
      const resultsList = document.createElement("div");
      resultsList.className = "jh-cm-results";
      searchWrap.appendChild(searchInput);
      searchWrap.appendChild(resultsList);
      box.appendChild(searchWrap);

      async function renderResults(query) {
        resultsList.innerHTML = "";
        const q = JH.normalizeText(query);
        const categories = Object.keys(dictionary.aliases);
        const filtered = q ? categories.filter((c) => c.toLowerCase().includes(q)) : categories;
        if (filtered.length === 0) {
          const empty = document.createElement("p");
          empty.className = "jh-cm-empty";
          empty.textContent = "No matching category.";
          resultsList.appendChild(empty);
          return;
        }
        for (const category of filtered.slice(0, 30)) {
          const value = await JH.resolveCategoryValue(category, candidateData, dictionary);
          const row = document.createElement("button");
          row.type = "button";
          row.className = "jh-cm-result-row";
          row.innerHTML =
            `<span class="jh-cm-result-cat">${escapeHtml(category)}</span>` +
            `<span class="jh-cm-result-val">${escapeHtml(previewValue(value))}</span>`;
          row.addEventListener("click", async () => {
            await JH.addCategoryAlias(category, fieldInfo.signature.rawLabel);
            finish({ action: "linked", category });
          });
          resultsList.appendChild(row);
        }
      }
      searchInput.addEventListener("input", () => renderResults(searchInput.value));
      renderResults("");

      // ---- or define a brand-new category ----
      const newSection = document.createElement("div");
      newSection.className = "jh-cm-section";
      const newToggle = document.createElement("button");
      newToggle.type = "button";
      newToggle.className = "jh-cm-link-btn";
      newToggle.textContent = "+ Create a new category instead";
      const newForm = document.createElement("div");
      newForm.className = "jh-cm-new-form";
      newForm.hidden = true;
      newForm.innerHTML =
        '<input type="text" class="jh-cm-new-id" placeholder="category id (e.g. drivers_license)">' +
        '<textarea class="jh-cm-new-value" placeholder="value to store" rows="2"></textarea>' +
        '<button type="button" class="jh-cm-primary-btn">Create &amp; fill</button>';
      newToggle.addEventListener("click", () => {
        newForm.hidden = !newForm.hidden;
      });
      newSection.appendChild(newToggle);
      newSection.appendChild(newForm);
      box.appendChild(newSection);

      newForm.querySelector(".jh-cm-primary-btn").addEventListener("click", async () => {
        const idInput = newForm.querySelector(".jh-cm-new-id");
        const valueInput = newForm.querySelector(".jh-cm-new-value");
        const id = idInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_+|_+$)/g, "");
        const value = valueInput.value.trim();
        idInput.classList.toggle("jh-cm-invalid", !id);
        valueInput.classList.toggle("jh-cm-invalid", !value);
        if (!id || !value) return;
        await JH.addCustomCategory(id, value, fieldInfo.signature.rawLabel);
        finish({ action: "created", category: id });
      });

      // ---- ignore this field permanently ----
      const footer = document.createElement("div");
      footer.className = "jh-cm-footer";
      const ignoreBtn = document.createElement("button");
      ignoreBtn.type = "button";
      ignoreBtn.className = "jh-cm-ignore-btn";
      ignoreBtn.textContent = "Ignore this field (don't ask again)";
      ignoreBtn.addEventListener("click", async () => {
        await JH.addIgnoredFieldSignature(location.origin, fieldInfo.signature);
        finish({ action: "ignored" });
      });
      footer.appendChild(ignoreBtn);
      box.appendChild(footer);

      document.body.appendChild(overlay);
      searchInput.focus();
    });
  };
})();
