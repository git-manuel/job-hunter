// Walks the live DOM for fillable fields and builds a matchable text signature for each one.
// Pure DOM reading, no fills happen here — see autofill-engine.js for what uses this.
(function () {
  const JH = self.JH || (self.JH = {});

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // Resume/cover-letter file inputs are very often deliberately hidden behind a custom-styled
  // "Attach resume" button (confirmed pattern on both GrupoBolt and GeekHunter) — visibility
  // filtering would wrongly exclude exactly the field we most need to find, so file inputs skip
  // the visibility check; everything else (decoy locale/CSRF hidden inputs, etc.) still needs it.
  function isScannable(el) {
    if (el.type === "file") return true;
    return isVisible(el);
  }

  function nearestPrecedingText(el) {
    // Fallback for label-less custom-styled widgets (e.g. a country-picker div with no
    // <label>/aria-label) — walk a couple of DOM steps back for the closest preceding text.
    let node = el;
    for (let hop = 0; hop < 3 && node; hop++) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const text = sibling.innerText && sibling.innerText.trim();
        if (text && text.length > 0 && text.length < 60) return text;
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  function buildSignature(el) {
    const attrText = JH.tokenizeAttr(`${el.name || ""} ${el.id || ""}`);
    const labelSources = [
      el.getAttribute("aria-label"),
      (el.labels && el.labels[0] && el.labels[0].innerText) || (el.closest("label") && el.closest("label").innerText),
      el.getAttribute("placeholder"),
      nearestPrecedingText(el),
    ].filter(Boolean);
    return {
      attrText,
      labelText: JH.normalizeText(labelSources.join(" ")),
      rawLabel: labelSources[0] || el.name || el.id || "",
    };
  }

  /** Returns [{element, signature}] for every fillable-looking field currently on the page. */
  JH.scanFormFields = function scanFormFields() {
    // Checkboxes/radios (consent agreements, EEO/demographic single-choice questions, etc.) are
    // deliberately never scanned — they're not worth a category match or an "unrecognized field"
    // modal prompt every time, so they're just left for the user to handle by hand.
    const selector =
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=password])" +
      ":not([type=checkbox]):not([type=radio]), " +
      "textarea, select, [role='combobox'], [class*='dropdown' i], [class*='select' i]:not(select)";
    const candidates = Array.from(document.querySelectorAll(selector));

    // Site chrome (a language switcher, cookie-consent picker, etc. in the nav/footer) has no
    // business being scanned — it's not part of the application, so it can never resolve to a
    // real category and only produces confusing "unrecognized field" prompts (confirmed: an
    // InHire page's <select> language switcher, with no <label>/name/id at all, surfaced as an
    // unmatched field literally labeled "Jobs" — a nearby nav-link text, not the field itself).
    // Scoping to elements inside the page's actual <form> excludes that cleanly, since real ATS
    // application fields are consistently form-wrapped even in class-name-obfuscated React apps.
    // Only apply this when at least one <form> exists — some sites render fields with no <form>
    // wrapper at all, and scoping to zero forms would wrongly scan nothing.
    const forms = document.querySelectorAll("form");
    const scoped = forms.length > 0 ? candidates.filter((el) => el.closest("form")) : candidates;

    // The generic custom-widget part of the selector (role=combobox, class*=dropdown/select) can
    // match several nested elements of the *same* widget — confirmed on a react-dropdown-select
    // instance: its root container, inner "-content" trigger, and "-dropdown-handle" arrow button
    // all matched independently, so one widget was scanned as up to 3 separate fields, each
    // popping its own near-identical "unrecognized field" modal in a row. Keeping only the
    // outermost matched element per cluster (dropping any candidate that's a descendant of
    // another candidate) collapses that back down to one field per widget. Native form elements
    // (input/select/textarea) never nest inside each other, so this is safe to apply uniformly.
    const scopedSet = new Set(scoped);
    const deduped = scoped.filter(
      (el) => !Array.from(scopedSet).some((other) => other !== el && other.contains(el))
    );

    return deduped
      .filter(isScannable)
      .map((element) => ({ element, signature: buildSignature(element) }))
      // A signature with nothing to match or show in a modal isn't worth surfacing at all.
      .filter((item) => item.signature.attrText || item.signature.labelText);
  };
})();
