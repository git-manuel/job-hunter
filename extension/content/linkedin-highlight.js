// Highlights the title of LinkedIn job search results whose description mentions "java".
// Pure string matching against [data-job-id] cards — no learning phase, no AI, works from the
// very first page load. Selector techniques (doubled innerText split, [data-job-id] cards) are
// the ones documented as reliable in the linkedin-automation skill.
(function () {
  const JH = self.JH || (self.JH = {});
  const HIGHLIGHT_CLASS = "job-hunter-java-highlight";
  const KEYWORD = /\bjava\b/i;

  function ensureStyleTag() {
    if (document.getElementById("job-hunter-highlight-style")) return;
    const style = document.createElement("style");
    style.id = "job-hunter-highlight-style";
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background: #FEF08A !important;
        outline: 2px solid #CA8A04;
        border-radius: 3px;
        padding: 0 2px;
      }
    `;
    document.head.appendChild(style);
  }

  function firstNonEmptyLine(text) {
    return (text || "")
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean);
  }

  function processCard(card) {
    const titleLink = card.querySelector("a[href*='/jobs/view/']");
    if (!titleLink) return;

    const cardText = card.innerText || "";
    if (!KEYWORD.test(cardText)) {
      titleLink.classList.remove(HIGHLIGHT_CLASS);
      return;
    }

    // Prefer highlighting the visible title span (first non-empty line), not the whole
    // (doubled) link text, per the linkedin-automation skill's "doubled innerText" gotcha.
    const titleText = firstNonEmptyLine(titleLink.innerText);
    const target =
      Array.from(titleLink.querySelectorAll("span")).find(
        (span) => span.textContent.trim() === titleText
      ) || titleLink;
    target.classList.add(HIGHLIGHT_CLASS);
  }

  function scan() {
    const cards = document.querySelectorAll("[data-job-id]");
    cards.forEach(processCard);
  }

  async function init() {
    const config = await JH.getConfig();
    if (!config.javaHighlightEnabled) return;

    ensureStyleTag();
    scan();

    // Job cards load incrementally as the user scrolls/paginates; observe for new ones.
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
