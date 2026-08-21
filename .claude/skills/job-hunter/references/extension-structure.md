# Extension structure (file-by-file)

Read this when navigating the codebase or deciding where a change belongs. Root: `C:\workspace\job-hunter\extension\`.

```
manifest.json
├── permissions: storage, unlimitedStorage, contextMenus, downloads
├── host_permissions: <all_urls>  (needed since external ATS forms live on unpredictable domains)
├── action: toolbar icon, no popup -> chrome.action.onClicked opens the options page
├── commands.auto-complete: suggested_key "Ctrl+Shift+U" -> the ONLY trigger for autofill now
│                            (right-click "JH - Auto Complete" was removed - see status.md)
└── content_scripts: two entries -
    1. <all_urls>: storage-schema, template-engine, field-categories, selector-fill,
       agent-bridge, field-scanner, category-modal(+css), cover-letter, autofill-engine,
       contact-actions  <- load order matters, later files call functions earlier ones define
    2. linkedin.com only: storage-schema, linkedin-highlight

background/background.js
├── seedInitialDataIfMissing()      # runs on onInstalled; fetches seed/*.json + resume PDF if storage empty
├── chrome.action.onClicked          # toolbar icon -> openOptionsPage()
├── chrome.contextMenus (onInstalled)# "JH - Draft email with resume" (mailto: links), "JH - Message with resume"
│                                     # (linkedin.com/in/* links only, via targetUrlPatterns) - NOT auto-complete
├── sendToTab(tabId, message)        # chrome.tabs.sendMessage wrapper that reads chrome.runtime.lastError
│                                     # itself instead of leaving an unhandled rejection Chrome shows as a red error
├── chrome.contextMenus.onClicked    # routes the two remaining menu items to sendToTab
├── chrome.commands.onCommand        # "auto-complete" -> queries the active tab -> sendToTab(..., {type:"job-hunter:auto-complete"})
├── IndexedDB (JobHunterDB)          # background.js is the ONLY writer - resumeBlob store, coverLetters store
├── mirrorBlobToDisk(blob, path)     # writes via chrome.downloads, WAITS for onChanged "complete" state before
│                                     # reading the resolved path (a race condition here previously left
│                                     # resumeMeta.mirroredPath empty - see gotchas.md)
└── chrome.runtime.onMessage         # job-hunter:save-resume, save-cover-letter, get-cover-letter, delete-cover-letter

shared/storage-schema.js             # chrome.storage.local keys + promise helpers, loaded everywhere via
│                                     # importScripts (background) or manifest content_scripts js[] (everyone else)
├── STORAGE_KEYS: config, candidateData, messageTemplate, resumeMeta, coverLetterIndex,
│                 pendingActions, processingStatus, categoryAliasOverrides, customCategories,
│                 customCandidateFields, ignoredFieldSignatures
├── getEffectiveCategoryDictionary() # merges field-categories.js's shipped defaults with user
│                                     # overrides/custom categories - THE function that answers
│                                     # "what does category X mean and how do I fill it"
├── resolveCategoryValue(category, candidateData, dictionary)
│                                     # ref starting "derived:" -> CATEGORY_DERIVATIONS fn;
│                                     # "custom:" -> customCandidateFields lookup;
│                                     # "file:resume"/"file:cover_letter" -> "__ATTACHMENT__" sentinel;
│                                     # otherwise a dotted-path lookup into candidateData
├── addCategoryAlias / addCustomCategory / deleteCustomCategory / addIgnoredFieldSignature / filterIgnored
├── queuePendingAction / getPendingActions / removePendingAction  # the Claude hand-off queue
├── setProcessingStatus              # live on-page toast broadcast while Claude works a pending item
├── flattenCandidateData             # dotted-path flatten, still used incidentally - NOT the primary
│                                     # value-resolution path anymore (resolveCategoryValue is)
└── derivePhoneParts / slugifyCompany

shared/field-categories.js           # pure functions + static data, NO storage access
├── DEFAULT_CATEGORY_REFS            # category -> candidateData path / "derived:x" / "file:x" / "custom:x"
├── DEFAULT_CATEGORY_ALIASES         # category -> alternate wordings (EN + PT-BR), one line per category
├── CATEGORY_DERIVATIONS             # first_name/last_name (split full_name), phone_local_digits/
│                                     # phone_country_name (from phone), country_name (from location)
├── normalizeText(s)                 # NFD-normalize, strip \p{Diacritic}, lowercase, collapse to a-z0-9+space
├── tokenizeAttr(attrValue)          # camelCase/dot-split then normalizeText - "salaryExpectation.CLT" ->
│                                     # "salary expectation clt"
├── matchCategory(signature, dictionary)
│                                     # tries attrText then labelText; multi-word aliases before single-word;
│                                     # bare "name"/"nome" are a special exact-string-equality case (see below)
│                                     # - they're deliberately NOT in any alias list (would false-positive on
│                                     # "company name") so a naive substring-in-alias-list loop would never
│                                     # even see them; the exact-match check happens BEFORE the loop
└── detectInteractionType(el)        # select/checkbox/file/textarea/text/combo-search-select by tag/type

content/field-scanner.js
└── scanFormFields()                 # querySelectorAll a broad selector (inputs minus hidden/submit/button/
                                      # reset/password, textarea, select, role=combobox, class*=dropdown/select);
                                      # file inputs SKIP the visibility filter (often intentionally hidden behind
                                      # a custom "Attach resume" button - confirmed pattern on 2+ real ATS sites);
                                      # everything else IS visibility-filtered (drops decoy hidden locale/CSRF
                                      # inputs); buildSignature() combines name/id (tokenized), aria-label,
                                      # <label>/placeholder, and a nearestPrecedingText() DOM-walk fallback for
                                      # label-less custom widgets

content/category-modal.js/.css       # showCategoryModal(fieldInfo, dictionary, candidateData) -> Promise
│                                     # resolves {action:"linked"|"created"|"ignored"|"dismissed", category?}
│                                     # - "linked": live-search over existing categories, picks one, adds the
│                                     #   field's raw label as a new alias
│                                     # - "created": name+value form -> customCandidateFields + customCategories
│                                     # - "ignored": persists via addIgnoredFieldSignature (origin-scoped) so an
│                                     #   irrelevant checkbox doesn't re-prompt every run
│                                     # - "dismissed": closing the X or clicking the overlay backdrop - NOT
│                                     #   persisted, will re-prompt next time
└── Scoped CSS with a jh-cm- class prefix since it's injected into arbitrary third-party pages

content/agent-bridge.js              # window.postMessage relay, NO token (unlike an earlier discarded design -
│                                     # see gotchas.md) since pendingActions is only ever written by this
│                                     # trusted content script, never by page code
├── "get-state"                      # candidateData, resumeMeta, messageTemplate, coverLetterIndex,
│                                     # pendingActions, categoryDictionary
├── "remove-pending-action" / "set-processing-status"
├── "reseed-resume"                  # re-fetches the bundled seed PDF and re-saves it through background.js's
│                                     # (now-fixed) mirrorBlobToDisk, for records stuck with an empty path
└── "relay-to-background"            # generic {messageType, messagePayload} passthrough to
                                      # chrome.runtime.sendMessage, for anything background.js owns

content/autofill-engine.js
├── showToast(message, {kind})       # fixed-position on-page notification; also listens for
│                                     # chrome.storage.onChanged on PROCESSING_STATUS scoped to
│                                     # location.href, for live Claude-progress toasts
├── scrapePageContext()              # best-effort company/role/recruiter scrape (LinkedIn only),
│                                     # used by contact-actions.js/cover-letter.js's template filling
├── fillMatchedField(m, candidateData, dictionary)
│                                     # cover_letter category -> JH.handleCoverLetterField(element);
│                                     # "__ATTACHMENT__" value -> queues attach-file pending action;
│                                     # otherwise setFieldValue() per detectInteractionType()
└── runAutoComplete()                # scan -> match/unmatched split -> fill matched -> modal loop over
                                      # (filterIgnored'd) unmatched -> summary toast. Triggered by
                                      # chrome.runtime.onMessage {type:"job-hunter:auto-complete"}
                                      # (from background.js's command listener - see status.md for the
                                      # current bug where this message isn't arriving)

shared/selector-fill.js              # NO per-site caching lives here - every call figures out live DOM state
├── simulateTyping(el, text)         # char-by-char with real InputEvents + 20ms waits - the fix for JS-driven
│                                     # input masks (see gotchas.md's salary-field bug); used for ALL single-
│                                     # line text fills now, not just "known masked" ones
├── discoverComboSearchWidgets(el)   # clicks a trigger, diffs document.querySelectorAll('input')/leaf elements
│                                     # before vs after to find whatever search box/results list appeared -
│                                     # replaces an earlier per-site-hardcoded-selector version
├── fillComboSearchSelect(el, value) # opens via discoverComboSearchWidgets, types the search text, clicks the
│                                     # first result containing it (substring match)
└── setFieldValue(el, inputType, value)
                                      # select/checkbox/text(always typed)/textarea(bulk-set, never masked in
                                      # practice)/combo-search-select/file(returns "needs-attachment" sentinel -
                                      # never a real failure, browsers block scripted file assignment period)

content/cover-letter.js              # UNTOUCHED by the category-matching rework - per-company cache via
│                                     # chrome.runtime.sendMessage to background.js's IndexedDB, or queues
│                                     # draft-cover-letter/attach-file pending actions on a cache miss
content/contact-actions.js           # UNTOUCHED - draft-email/message-profile pending-action queuing for the
│                                     # two remaining context-menu items
content/linkedin-highlight.js        # UNTOUCHED - pure string matching, linkedin.com only, no AI ever needed

options/options.html + options.js    # Resume / Cover Letter / Candidate Data / Email-DM-Template / Pending /
                                      # Field Categories tabs - all auto-save on input (~600ms debounce), no
                                      # manual save buttons anywhere. Field Categories tab is the bulk-review
                                      # surface for the dictionary (the modal only handles one field at a time).

seed/candidate-data.seed.json        # the actual candidate profile content (was data/candidate_data.yml in
                                      # the old Spring Boot design) - auto-seeded into chrome.storage.local
seed/message-template.seed.json      # {subject, body} - only .body is used now (single shared template, no
                                      # separate email/DM subject fields - subject is auto-derived in code)
seed/Manuel_Almeida_Resume.pdf       # bundled default resume
```
