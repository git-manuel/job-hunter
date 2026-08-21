// Deterministic {{placeholder}} substitution — no AI involved, used for email/DM templates.
(function () {
  const JH = self.JH || (self.JH = {});

  /**
   * Fills `{{key}}` placeholders in a string from `values`. Unknown placeholders are left
   * as-is (visible, so a missing field is obvious rather than silently blanked).
   */
  JH.fillTemplate = function fillTemplate(text, values) {
    if (!text) return "";
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
      const value = values ? values[key] : undefined;
      return value === undefined || value === null || value === "" ? match : String(value);
    });
  };
})();
