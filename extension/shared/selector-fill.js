// Fill primitives for a live-matched field (see field-categories.js / field-scanner.js). No
// per-site caching lives here anymore — every call figures out how to interact with the element
// fresh, using the DOM state in front of it right now.
(function () {
  const JH = self.JH || (self.JH = {});

  JH.wait = function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  /**
   * Dispatches a real keystroke-like sequence (incremental value + InputEvent per character)
   * rather than a single bulk value-set. Needed for JS-driven input masks (salary, phone) that
   * build up their own formatting state per keystroke — a bulk set can be silently misread by
   * that logic and produce a wrong formatted value (confirmed case: a salary field that reads a
   * bulk-set "15000" as an unformatted 7-digit number and renders R$1,500,000 instead of R$15,000
   * when digits arrive one at a time as real typing would). Since this is safe for *any* plain
   * text field (masked or not — a couple hundred ms of extra latency is a non-issue for a name or
   * email field), every single-line text fill goes through this rather than trying to first
   * detect "is this field masked".
   */
  JH.simulateTyping = async function simulateTyping(el, text) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    ).set;
    let current = "";
    for (const char of text) {
      current += char;
      setter.call(el, current);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
      await JH.wait(20);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return true;
  };

  /**
   * Opens a custom (non-native) dropdown by clicking its trigger, then figures out what appeared
   * by diffing the DOM before/after — no per-site selector needed. Works for widgets like
   * react-dropdown-select (confirmed: click opens a fresh search `<input>` plus a fresh list of
   * option elements) but is inherently a best-effort heuristic, not guaranteed for every custom
   * widget library a site might use.
   */
  JH.discoverComboSearchWidgets = async function discoverComboSearchWidgets(triggerEl) {
    const beforeInputs = new Set(document.querySelectorAll("input"));
    const beforeLeaves = new Set(
      Array.from(document.querySelectorAll("li, [role='option'], div, span")).filter((n) => n.children.length === 0)
    );
    triggerEl.click();
    await JH.wait(150);
    const searchInput =
      Array.from(document.querySelectorAll("input")).find((i) => !beforeInputs.has(i) && isVisible(i)) || null;
    const findResultItems = () =>
      Array.from(document.querySelectorAll("li, [role='option'], div, span")).filter(
        (n) => n.children.length === 0 && !beforeLeaves.has(n) && isVisible(n)
      );
    return { searchInput, findResultItems };
  };

  /** Opens a custom searchable combobox, types `value` into whatever search box appeared, clicks the first matching result. */
  JH.fillComboSearchSelect = async function fillComboSearchSelect(el, value) {
    const { searchInput, findResultItems } = await JH.discoverComboSearchWidgets(el);
    if (!searchInput) return false;
    await JH.simulateTyping(searchInput, String(value));
    await JH.wait(150);
    const needle = String(value).toLowerCase();
    const match = findResultItems().find((c) => c.textContent.trim().toLowerCase().includes(needle));
    if (!match) return false;
    match.click();
    await JH.wait(100);
    return true;
  };

  /**
   * Sets one field's value on the live DOM, dispatching the events a real user interaction would.
   * Returns `true` (filled), `false` (found the element but couldn't fill it — a real failure),
   * or the string `"needs-attachment"` for file inputs, which is a *known*, expected case (never
   * a fill failure) — browsers block scripts from assigning `.files`, full stop, so this always
   * needs a live Claude session for that one step, on every site, permanently.
   */
  JH.setFieldValue = async function setFieldValue(el, inputType, value) {
    if (!el || value === undefined || value === null || value === "") return false;

    if (inputType === "select") {
      const options = Array.from(el.options || []);
      const match = options.find(
        (opt) => opt.textContent.trim().toLowerCase() === String(value).trim().toLowerCase()
      );
      if (!match) return false;
      el.value = match.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (inputType === "checkbox") {
      const shouldCheck = value === true || String(value).toLowerCase() === "true";
      if (el.checked !== shouldCheck) el.click();
      return true;
    }

    if (inputType === "text") {
      return JH.simulateTyping(el, String(value));
    }

    if (inputType === "textarea") {
      // Never masked in practice, and can be long (cover letters) — the fast bulk-set path.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (inputType === "combo-search-select") {
      return JH.fillComboSearchSelect(el, value);
    }

    if (inputType === "file") {
      return "needs-attachment";
    }

    return false;
  };
})();
