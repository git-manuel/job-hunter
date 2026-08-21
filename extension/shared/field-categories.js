// Local, offline field-category matching engine + shipped alias dictionary. Pure functions and
// static data only — no storage access here (that lives in storage-schema.js's
// getEffectiveCategoryDictionary, which layers user edits on top of these shipped defaults).
//
// The whole point: common application-form fields (name, email, LinkedIn, resume, salary, phone)
// are worded differently across ATS vendors and languages, but the underlying *meaning* repeats
// constantly. Recognizing that locally via a regex/alias dictionary means a brand-new site can be
// autofilled correctly on the very first visit, with zero network calls and zero AI involvement —
// no per-site "learning" pass required.
(function () {
  const JH = self.JH || (self.JH = {});

  // category -> which candidateData path (or derivation/attachment sentinel) supplies its value.
  // One line per category, deliberately flat and easy to scan/hand-edit.
  JH.DEFAULT_CATEGORY_REFS = {
    full_name: "contact.full_name",
    first_name: "derived:first_name",
    last_name: "derived:last_name",
    email: "contact.email",
    phone: "contact.phone",
    phone_local_digits: "derived:phone_local_digits",
    phone_country: "derived:phone_country_name",
    linkedin: "contact.linkedin",
    github: "contact.github",
    portfolio: "contact.portfolio",
    location: "contact.location",
    country: "derived:country_name",
    headline: "headline",
    summary: "summary",
    resume: "file:resume",
    cover_letter: "file:cover_letter",
    salary: "compensation.salary_floor_brl_monthly",
    salary_clt: "compensation.salary_floor_brl_monthly",
    salary_pj: "compensation.salary_floor_brl_monthly",
    salary_usd: "compensation.salary_floor_usd_monthly",
    salary_eur: "compensation.salary_floor_eur_monthly",
    notice_period: "work_authorization.notice_period",
    work_authorization: "work_authorization.status",
    visa_notes: "work_authorization.visa_notes",
    remote_only: "preferences.remote_only",
  };

  // category -> alternate wordings that should all resolve to it. Compared after accent-stripping
  // (see normalizeText), so "codigo do pais" already matches "código do país" without needing to
  // hand-write every accented variant. Bare "name"/"nome" are deliberately absent — see the
  // AMBIGUOUS_BARE_WORDS handling in matchCategory below.
  JH.DEFAULT_CATEGORY_ALIASES = {
    full_name: ["full name", "fullname", "complete name", "your name", "candidate name", "applicant name", "nome completo", "seu nome"],
    first_name: ["first name", "given name", "primeiro nome"],
    last_name: ["last name", "surname", "family name", "sobrenome", "ultimo nome", "apelido"],
    email: ["email", "e-mail", "confirm email", "confirmar email", "confirme seu email", "endereco de email"],
    phone: ["phone", "phone number", "cell phone", "mobile number", "telefone", "celular", "whatsapp"],
    phone_country: ["country code", "codigo do pais", "pais do telefone", "ddi", "dial code"],
    linkedin: ["linkedin", "linkedin url", "linkedin profile", "perfil linkedin"],
    github: ["github", "github url", "perfil github"],
    portfolio: ["portfolio", "portfolio url", "personal website", "site pessoal"],
    location: ["location", "city", "current location", "cidade", "localizacao", "onde voce mora"],
    country: ["country of residence", "pais de residencia"],
    headline: ["headline", "professional headline", "titulo profissional"],
    summary: ["summary", "professional summary", "about you", "resumo profissional", "sobre voce"],
    resume: ["resume", "resumé", "cv", "curriculum", "curriculo", "curriculum vitae", "attach resume", "anexar curriculo"],
    cover_letter: ["cover letter", "carta de apresentacao", "why do you want", "motivation letter", "carta de motivacao"],
    salary: ["salary", "salary expectation", "expected salary", "desired salary", "pretensao salarial", "salario", "salario pretendido"],
    salary_clt: ["salary expectation clt", "clt salary", "salario clt", "pretensao salarial clt"],
    salary_pj: ["salary as contractor", "salary expectation pj", "pj salary", "salario pj", "pretensao salarial pj", "contractor salary"],
    salary_usd: ["salary usd", "expected salary usd"],
    salary_eur: ["salary eur", "expected salary eur"],
    notice_period: ["notice period", "aviso previo"],
    work_authorization: ["work authorization", "visa status", "autorizacao de trabalho"],
    visa_notes: ["visa notes", "visa details"],
    remote_only: ["remote only", "open to remote", "somente remoto"],
  };

  // A handful of predictable, hardcoded transforms — not a generic scripting layer, just the
  // specific normalizations the user asked for (full name -> first/last, phone -> parts, etc).
  JH.CATEGORY_DERIVATIONS = {
    first_name: (cd) => JH.splitFullName(cd && cd.contact && cd.contact.full_name).first,
    last_name: (cd) => JH.splitFullName(cd && cd.contact && cd.contact.full_name).last,
    phone_local_digits: (cd) => JH.derivePhoneParts(cd && cd.contact && cd.contact.phone).localDigits,
    phone_country_name: (cd) => JH.derivePhoneParts(cd && cd.contact && cd.contact.phone).countryName,
    country_name: (cd) => JH.deriveCountryFromLocation(cd && cd.contact && cd.contact.location),
  };

  JH.splitFullName = function splitFullName(fullName) {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { first: "", last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  };

  JH.deriveCountryFromLocation = function deriveCountryFromLocation(location) {
    const parts = String(location || "").split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };

  /** Lowercase, accent-stripped, punctuation-collapsed — the normal form everything is matched in. */
  JH.normalizeText = function normalizeText(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // combining diacritical marks: ã->a, ç->c, é->e, ...
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  };

  /** "linkedinUsername" -> "linkedin username"; "salaryExpectation.CLT" -> "salary expectation clt". */
  JH.tokenizeAttr = function tokenizeAttr(attrValue) {
    return JH.normalizeText(String(attrValue || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  };

  // "name"/"nome" alone would false-positive on "company name", "file name", "nome da empresa",
  // etc. if matched as a substring — they're excluded from every alias list above and handled
  // here as an exact-string-equality special case instead (attribute token or the *whole*
  // normalized label, never a fragment of something longer).
  const AMBIGUOUS_BARE_WORDS = new Set(["name", "nome"]);

  /**
   * Matches one field signature ({attrText, labelText}, see field-scanner.js) against a
   * dictionary ({aliases, refs}). Attribute tokens (name/id) are tried before label text — more
   * standardized across ATS vendors than free-text labels. Multi-word aliases are tried before
   * single-word ones so "nome completo" can't be shadowed by a coincidental shorter match.
   */
  JH.matchCategory = function matchCategory(signature, dictionary) {
    const candidates = Object.entries(dictionary.aliases)
      .flatMap(([category, aliases]) => aliases.map((alias) => ({ category, alias: JH.normalizeText(alias) })))
      .sort((a, b) => b.alias.split(" ").length - a.alias.split(" ").length || b.alias.length - a.alias.length);

    function tryMatch(text) {
      if (!text) return null;
      // Bare "name"/"nome" are never in the alias lists themselves (see above), so this has to
      // be checked explicitly against the *whole* text, not found by iterating aliases — that's
      // what makes id="name" match while id="companyName" ("company name" != "name") doesn't.
      if (AMBIGUOUS_BARE_WORDS.has(text)) return { category: "full_name", alias: text };
      for (const { category, alias } of candidates) {
        if (!alias) continue;
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`).test(text)) return { category, alias };
      }
      return null;
    }

    return tryMatch(signature.attrText) || tryMatch(signature.labelText);
  };

  /** What kind of DOM interaction a matched field needs — separate concern from *which* category it is. */
  JH.detectInteractionType = function detectInteractionType(el) {
    if (el.tagName === "SELECT") return "select";
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "file") return "file";
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.tagName === "INPUT") return "text";
    return "combo-search-select"; // non-native trigger: div/button/role=combobox custom widget
  };
})();
