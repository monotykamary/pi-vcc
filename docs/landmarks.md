# Landmarks & Novelty — `tom` branch vs upstream `v0.3.15`

The `tom` branch (now at v0.5.0) diverged from upstream at `v0.3.15` with 45 commits, +15,463 lines across 54 files. Below is each landmark, what it does, and what makes it novel — no upstream equivalent exists for any of these.

---

## 1. Deep Error Extraction & Outstanding Context

**Files:** `src/core/build-sections.ts` (`extractOutstandingContext`)

**What it does:** Scans the last 25 normalized blocks for 6 categories of error/problem signals:

| Category | Detection method |
|---|---|
| Bash non-zero exits | `exitCode` field (was captured in normalization but never consumed) |
| TypeScript compiler errors | `TSC_ERROR_RE` in bash output, with file path extraction for resolution detection |
| Test failures | `FAIL/✗/✘/×` in output |
| Empty grep/glob results | Empty tool_result body paired with the preceding tool_call's pattern |
| Generic tool errors | `isError` flag on tool_result |
| User/assistant blocker mentions | `BLOCKER_RE` on substantive sentences |

**Resolution detection:** TSC errors are cross-referenced with subsequent file edits — if the same file is edited after the error, the entry is tagged `[RESOLVED]` instead of `[ERROR]`. This is computed via a `Map<position, Set<path>>` from the tail.

**Priority tags:** Every item gets `[ERROR]`, `[WARN]`, or `[INFO]` based on source (tsc, bash:exit, tests, no matches, user, generic).

**What's novel:** Upstream compaction stores no structured error state at all — errors are just part of the raw message stream that gets summarized or lost. The priority-tag + resolution-detection system is an entirely new "live error register" that persists across compactions, giving the LLM a curated list of what's still broken vs. already fixed.

---

## 2. Mastra OM-Inspired Enhancements (5 sub-features)

**File:** `src/core/format.ts`, `src/core/summarize.ts`

### 2a. Current Status section → Outstanding Context

Renamed from upstream's vague "outstanding context" to a structured, priority-tagged error register (see #1).

### 2b. Priority Error Tags

`[ERROR]`, `[WARN]`, `[INFO]`, `[RESOLVED]` markers on every context item.

### 2c. Cache-Friendly Section Ordering

Sections are emitted in a deterministic split: stable sections first (Session Goal, User Preferences, Files And Changes, Commits), volatile sections last (Type Catalog, Outstanding Context, Earlier Turns). This maximizes prompt-cache hits across sequential compactions because the prefix stays byte-identical when stable sections haven't changed.

**What's novel:** Upstream has no concept of section ordering for caching — sections are just whatever the summarizer produces. This is a prompt-engineering optimization specifically targeting KV-cache reuse in LLM inference.

### 2d. Compaction-Scoped Recall

The `messageRange` field in compaction details stores entry IDs `[firstSummarizedId, lastKeptEntryId]`. `vcc_recall scope:compaction:N` resolves these IDs to global message indices and filters the search to only messages within that compaction's original range. This lets the LLM say "search only what was summarized in compaction #2" rather than the entire session.

**What's novel:** No upstream equivalent — there's no compaction metadata at all in upstream (details are empty `{}`).

### 2e. Metadata Footer → Compaction Details

Every compaction stores a structured `PiVccCompactionDetails` object in the compaction entry's `details` field:

- `compactor: "pi-vcc"`, `version`, `sections[]`, `sourceMessageCount`, `previousSummaryUsed`, `messageRange`, `compressionRatio`, `timestamp`, `tokensBefore`, `keptCount`, `keptTokensEst`, `postTokensEst`

**What's novel:** Upstream stores an empty `{}` in compaction details. This metadata is what enables compaction-scoped recall, debugging, and future tooling.

---

## 3. Symbol-Annotated Files & Type Catalog

**File:** `src/extract/shared-symbols.ts` (`extractFileAndSymbolData`)

**What it does:** A single-pass extraction that replaces three previously separate extractors (`extractFiles`, `extractSymbolChanges`, `extractTypeCatalog`) that each independently scanned the same tool results with overlapping regexes. The unified pass:

1. **File Activity:** Collects read/modified/created sets, with symbol names per file.
2. **Type Catalog:** Extracts exported signatures from files — `export function foo()`, `pub fn bar()`, `def baz()`, etc. Printed as `file: signature` pairs.
3. **Symbol Changes:** Tracks every symbol name, its file, kind (function/type/class/variable), and access mode (read vs modified).

Supports **9 languages**: TypeScript, Rust, Go, Python, Java, C/C++, Ruby, Elixir, Zig. Each language has dedicated declaration regexes, signature patterns, and a fast `DECL_SCREEN_RE` pre-filter that rejects ~80% of lines before the full regex cascade runs.

**Performance features:**

- `eachLine()` iterator using `indexOf("\n")` instead of `split()` — avoids allocating a string array (~30μs/scan saved per 300-line tool result, ×600 results = ~18ms reclaimed)
- `Set` for O(1) symbol dedup instead of `Array.includes()` O(n)
- `DECL_SCREEN_RE` fast-reject filter before the 15-regex cascade
- `ToolResultIndex` — one O(n) pre-scan builds a tool_call→tool_result map shared across all extractors, eliminating triple-redundant look-ahead scanning

**What's novel:** Upstream has no symbol extraction at all. The type catalog gives the LLM an "API surface area" of every file touched — the LLM knows what functions/types exist without reading the file. Symbol changes give the LLM a diff-level understanding of what was modified.

---

## 4. Multi-Resolution Transcript

**File:** `src/core/brief.ts`, `src/sections.ts`

**What it does:** The transcript is emitted at two compression levels simultaneously:

| Resolution | Format | Compression | Use |
|---|---|---|---|
| Brief | Text lines (`[user]`, `[assistant]`, `[tool_error]`) | Heavy — truncated, tool calls collapsed | Read by LLM as-is in the summary prompt |
| Structured | `TranscriptEntry[]` JSON objects | Same data, object format | Machine-parseable for tooling/tests |

**Enhancements over a flat transcript:**

- **Tool call collapsing:** Consecutive identical tool calls (`* bash "npm test" (#5)`, `* bash "npm test" (#6)`) become `* bash "npm test" (#5, #6) x2`.
- **Tool call capping:** Per `[assistant]` turn, only the 8 most recent tool calls are kept; earlier ones are summarized as `(N earlier tool-call entries omitted)`. Keeps tail (decision-making edits) over head (exploration noise).
- **Consecutive error collapsing:** 20 back-to-back `[tool_error] bash (#N) Command aborted` become one `[tool_error] bash (#refs...) x20`.
- **Source indices:** Every line carries `(#N)` mapping back to the original message index for traceability.
- **Self-talk stripping:** Removes "Hmm,", "Actually,", "Wait," etc. from assistant text (up to 2x for chains).
- **Bash compression:** Strips `cd ... &&` prefixes, pipe-tail formatting commands (`| head`, `| sort`), caps at 120 chars.
- **Stopword-aware truncation:** `truncateTokens()` counts content words (skipping 70+ stop words) instead of raw length. Uses `CONTENT_WORD_RE` Unicode regex instead of `Intl.Segmenter` (2× faster, identical output).

**What's novel:** Upstream produces no structured transcript at all — it passes raw messages to the LLM summarizer. The brief transcript is a lossy-but-useful compression that survives across compactions without LLM re-processing.

---

## 5. Causal Chain Extraction for Turn Summaries

**File:** `src/core/brief.ts` (`extractCausalChain`, `identifyTurns`), `src/core/causal-keys.ts`

**What it does:** Each conversational turn gets a one-liner summary that includes extracted cause → resolution chains when present. The extraction is entirely algorithmic (no LLM):

1. **Marker scanning:** 35 cause markers (`"the issue is"`, `"fails because"`, `"missing "`, `"unhandled "`, etc.) and 60+ resolution markers (`"fix this by"`, `"by adding"`, `"replaced with"`, `"removed "`, etc.) are scanned against assistant text.

2. **Fragment extraction:** After a marker match, a bounded fragment is extracted — scans forward until a sentinel character (`,.;!?↵`) or `FRAGMENT_MAX` (60 chars), whichever comes first. O(n) via `indexOf` + linear char scan; no regex backtracking possible.

3. **Multi-sentence awareness:** If both cause and resolution aren't found in the full text, per-sentence scanning is tried (handles "The issue is a race condition. I fixed it by adding a mutex.").

4. **Turn summary synthesis:** `synthesizeTurnSummary()` composes `user goal → cause fragment → resolution fragment → key actions`, with dedup and capping.

5. **Causal breadcrumbs:** `buildCausalBreadcrumb()` produces a `file|resolution-key` token for the recall system. The resolution key is refined through `refineBreadcrumbKey()` which strips 90+ stop words (including marker-remnant verbs like "added", "replaced") and takes up to 3 content words joined with `-`.

**Example turn summaries:**

```
"Fix the login bug" → race condition in session cache → adding mutex guard → edited auth.ts
"Refactor the API layer" → stale cache invalidation → cache-busting header → edited api.ts, edited middleware.ts +2 more
```

**What's novel:** Upstream turn summaries (if they existed) would just list actions. The causal chain extracts *why* a change was made and *how* it was resolved — this information survives across compactions via breadcrumbs and is searchable by `vcc_recall`. No other compaction system (claude-code, codex) does causal extraction.

---

## 6. Breadcrumb System

**File:** `src/core/summarize.ts` (`extractBreadcrumb`, `mergeHeaderSection`)

**What it does:** When a section exceeds its cap (e.g., Session Goal capped at 8, Earlier Turns at 15), the overflowed items are compressed into breadcrumb tokens:

```
[Earlier Turns]
- ...recall: auth.ts|mutex-guard, api.ts|cache-busting
- "Refactor the API layer" → edited api.ts +2 more
```

**How it works:** Each capped line is run through `extractBreadcrumb()`:

- V2 (causal): Produces `file|resolution-key` format
- V1 (fallback): Produces file path or first few content words

Breadcrumbs are **preserved across compactions** — when `mergeHeaderSection` runs, it separately tracks breadcrumb lines (`- ...recall: ...`) and content lines, never re-capping breadcrumbs. They accumulate across compactions as a lossy index of what was summarized away.

**What's novel:** This is a compaction-native index structure. Other tools lose information when it scrolls off — pi-vcc keeps a compressed, searchable pointer. The agent can `vcc_recall` with any breadcrumb term to retrieve the full original context.

---

## 7. Handoff Preamble

**File:** `src/core/summarize.ts`

Every compaction summary is prepended with:

> This summary captures work done before the most recent messages in this session. Read it to pick up context — this is work already in progress. Do not recap what was done, do not ask what to do next. Continue directly where you left off. Use `vcc_recall` to search for prior work, decisions, and context from before this summary.

**What's novel:** Upstream has no preamble at all — the LLM receives a bare summary and often responds by recapping what was done or asking "what would you like me to do next?" The handoff preamble is direct prompt engineering that eliminates this waste. The `vcc_recall` mention ensures the LLM knows it has a search tool for deeper context.

---

## 8. Invisible Continue After Compaction

**File:** `src/core/invisible-continue.ts`, `src/hooks/before-compact.ts`

**What it does:** When compaction interrupts an in-progress agent turn (e.g., the assistant was mid-tool-cycle with `stopReason: toolUse`, or hit `stopReason: length`), the agent loop would normally exit because:

1. `willRetry=false` after compaction
2. The session's `while` loop sees no queued messages
3. The agent stalls — user sees nothing happening

The fix has 3 layers:

- **`session_compact` handler:** After compaction, inspects the last message in the rebuilt context. If it's an assistant that wasn't a clean stop/abort/error → calls `triggerInvisibleContinue()`.

- **`triggerInvisibleContinue()`:** Captures the live `Agent` instance via a monkey-patch on `Agent.prototype.subscribe` (chains with pi-retry's existing patch). Calls `agent.prompt([])` after the session loop exits — a blank prompt that restarts the agent loop with the compacted context. The LLM sees no new user message; it just continues from where it was.

- **`continue()` fallback:** Monkey-patches `Agent.prototype.continue()` so that when it throws "Cannot continue from message role: assistant" (common after compaction rebuilds), it falls back to `prompt([])` instead of letting the session loop die. Includes:
  - Stop-reason check: only continues for mid-task (toolUse, length), not clean stops or user aborts
  - Double-continuation guard (RC7): checks `_lastInvisibleContinueTime` timestamp so pi-retry and pi-vcc don't both fire `prompt([])`

**What's novel:** Upstream has no mechanism for resuming after compaction — the agent simply stops and the user must type something to continue. This is the first automatic "invisible" resume that doesn't inject any message into the conversation (unlike upstream's follow-up-prompt feature which adds a user message).

---

## 9. Per-Model Compaction Thresholds & Proactive Trigger

**File:** `src/core/settings.ts`, `src/hooks/proactive-threshold.ts`

**What it does:** Allows configuring when compaction triggers on a per-model basis:

```json
{
  "globalThreshold": { "compactPercent": 65 },
  "modelThresholds": {
    "neuralwatt/zai-org/GLM-5.1-FP8": { "compactPercent": 50 }
  }
}
```

- `compactPercent`: compact when context is N% full (e.g., 65 = compact at 65%)
- `reserveTokens`: absolute token budget override

**Proactive trigger** fires on:

1. `agent_end` — after each agent turn, checks if context exceeds the current model's threshold
2. `model_select` — on model switch, checks if context already exceeds the new model's capacity
3. Cooldown: 3-second timer after any compaction to prevent double-triggering
4. `proactiveTriggerActive` flag prevents `session_before_compact` from cancelling a compaction that the proactive trigger itself initiated

**What's novel:** Upstream has one global threshold for all models. This enables e.g. compacting GLM-5.1 at 50% context while letting Claude Opus run to 85% — respecting per-model context quality degradation curves.

---

## 10. Task-Boundary-Aware Cut (`buildOwnCut`)

**File:** `src/hooks/before-compact.ts`

**What it does:** Instead of cutting at a fixed message index, `buildOwnCut` finds a safe cut point by:

1. **Scanning backward** from the end to find the last user message
2. **Checking if the turn is in-progress** (has unmatched toolCall IDs — assistant started but didn't finish). If so, pushes the cut back to the previous user message
3. **Mid-cycle boundary** for single-user agentic sessions: if there's only one user message and a long tool-call chain, finds a completed assistant→toolResult cycle boundary at the midpoint and cuts there (instead of compact-all which destroys the tail)
4. **Orphan recovery:** If `firstKeptEntryId` is `""` (sentinel from prior compact-all) or points to a non-existent entry, starts collecting from right after the last compaction
5. **Entry-ID ranges:** Uses entry IDs (not numeric indices) for message range tracking, so `vcc_recall` can correctly resolve ranges across branches where indices would be branch-relative

**What's novel:** Upstream uses pi-core's built-in cut algorithm which is a simple token-budget split. Task-boundary awareness means the compaction never cuts mid-tool-cycle, preserving conversational coherence without orphaned tool results.

---

## 11. vcc_recall — BM25 Search with Spelling Variants

**File:** `src/core/search-entries.ts`, `src/tools/recall.ts`

**What it does:** Full-text search over session history with:

- **BM25-lite ranking:** IDF × TF saturation with length normalization. Not a simple substring match — multi-term queries rank by relevance.
- **British/American spelling expansion:** `SUFFIX_VARIANT_PAIRS` expands query terms: "authorization" matches "authorisation", "colour" matches "color", etc. Uses fixed alternation `(?:our|or)` instead of optional quantifiers `ou?r` to prevent ReDoS backtracking.
- **Precompiled term cache:** All term regexes compiled once in `compileTerms()`, shared across `countMatches`, `buildBM25Context`, `bm25Score`, and snippet generation.
- **Score-ratio noise floor:** Results below 10% of the top score are excluded (prevents OR-semantics pulling in tangential matches for multi-term queries)
- **Min-term-match:** For 3+ term queries, requires at least 2 terms to match (prevents single-common-word matches)
- **Hard cap:** 50 results max, 5 pages max
- **Thinking content:** `fullText()` includes thinking/reasoning content in searchable text — you can search for model reasoning, not just visible output
- **Lineage scoping:** `scope:lineage` (default) only searches the active branch; `scope:all` searches everything; `scope:compaction:N` searches a specific compaction's original message range
- **Structure-preserving output:** `format-recall.ts` groups results into conversation segments (user + associated tool calls + results), shows match counts per segment, includes ±1 segment of context around first match

**What's novel:** Upstream has no search tool at all. The recall tool is a local-first, zero-dependency search engine (no SQLite, no external index) that runs entirely in-process. BM25 + spelling variants + compaction scoping is an order of magnitude more useful than simple grep-over-messages.

---

## 12. Section Merging & Accumulation Across Compactions

**File:** `src/core/summarize.ts` (`mergePrevious`, `mergeHeaderSection`, `mergeFileLines`)

**What it does:** When a compaction's output becomes the `previousSummary` for the next compaction, the summary isn't re-LLM'd — it's algorithmically merged:

- **Volatile sections** (Outstanding Context, Type Catalog) are always replaced with fresh-only — stale errors/signatures would be wrong
- **Stable sections** (Session Goal, User Preferences, Files And Changes, Commits, Earlier Turns) are line-level deduped and merged: new lines appended, caps enforced, overflow goes to breadcrumbs
- **Files And Changes** has category-aware merging: paths deduped across compactions, Modified takes priority over Created, `+recall:` breadcrumbs for overflow
- **Brief transcript** is concatenated (prev + fresh) and then capped at 120 lines
- **Preamble stripping:** `stripRecallNote()` removes the handoff preamble and legacy RECALL_NOTE from `previousSummary` so they don't stack up

**What's novel:** Upstream passes `previousSummary` as-is to the LLM summarizer with no structural awareness. This algorithmic merge guarantees that accumulated context (goals, preferences, file activity) is never lost across compactions — it's merged, deduped, and bounded.

---

## 13. Message Normalization Pipeline

**File:** `src/core/normalize.ts`, `src/core/filter-noise.ts`

**What it does:** Converts raw `Message[]` into a flat `NormalizedBlock[]` stream:

- **Bash messages:** First-class `bash` kind with `command`, `output`, `exitCode` fields (upstream treats bash as generic tool_call/tool_result pairs)
- **Thinking blocks:** Extracted as `thinking` kind with `redacted` flag, then filtered out by `filterNoise` (not discarded — available for recall search)
- **Tool calls/results:** Split from assistant content arrays into separate `tool_call` / `tool_result` blocks with `sourceIndex` for traceability
- **Noise filtering:** Removes `TodoWrite/Read`, `ToolSearch`, `WebSearch`, `AskUser`, XML wrappers (`<system-reminder>`, `<ide_opened_file>`, `<command-message>`, `<context-window-usage>`), and hollow user messages ("Continue from where you left off.", "No response requested.")
- **Sanitization:** All text passes through `sanitize()` to strip control characters and normalize whitespace

**What's novel:** Upstream passes raw messages directly to the summarizer. The normalization pipeline gives every extraction step a clean, uniform data model — bash commands are queryable by exit code, tool calls are indexed, thinking is preserved for search.

---

## 14. Supply-Chain Hardening

**Commits:** `8a9e582`, `976ac9c`

- **npm-shrinkwrap.json** — pins all transitive dependencies, making builds reproducible
- **`.npmignore`** — excluded test files, fixtures, benchmarks, and source maps from the npm package, shrinking it from 16.3 MB to 87 KB (188× reduction)
- **Audit findings resolved**

**What's novel:** Not a feature per se, but the package-size fix is the difference between "can't install pi-vcc in an air-gapped environment" and "installs instantly."

---

## 15. Override-Default-Compaction by Default

**File:** `src/core/settings.ts`

`overrideDefaultCompaction: true` is now the default. This means pi-vcc handles *all* compactions (manual `/compact`, auto-threshold, overflow) unless the user explicitly opts out. Previously this was opt-in.

The `session_before_compact` handler uses the `PI_VCC_COMPACT_INSTRUCTION` marker to distinguish explicit `/pi-vcc` invocations from regular compactions, and only processes regular compactions when `overrideDefaultCompaction` is enabled.

**What's novel:** Upstream's default compaction is an LLM-in-the-loop summarizer. By defaulting to override, pi-vcc replaces the LLM summarizer with its deterministic, structured approach — zero LLM tokens spent on summarization, zero latency from an LLM call, and guaranteed section structure.

---

## Summary Table

| # | Landmark | Novelty vs. Upstream |
|---|---|---|
| 1 | Deep Error Extraction | No upstream error register; priority tags + resolution detection are new |
| 2 | Mastra OM Enhancements | Cache ordering, compaction-scoped recall, metadata footer — all new |
| 3 | Symbol Extraction + Type Catalog | No upstream symbol awareness; 9-language support + unified single-pass |
| 4 | Multi-Resolution Transcript | Upstream has no transcript layer; brief + structured is new |
| 5 | Causal Chain Extraction | No upstream causal analysis; marker scanning is O(n) and deterministic |
| 6 | Breadcrumb System | No upstream overflow preservation; lossy index across compactions is new |
| 7 | Handoff Preamble | Upstream has no preamble; prompt-engineering against recap-waste is new |
| 8 | Invisible Continue | Upstream stalls after compaction; zero-injection resume is new |
| 9 | Per-Model Thresholds | Upstream has one global threshold; proactive trigger is new |
| 10 | Task-Boundary Cut | Upstream uses token-budget split; mid-cycle + orphan recovery is new |
| 11 | vcc_recall (BM25 + Variants) | No upstream search tool; BM25 + spelling + compaction scoping is new |
| 12 | Section Merging | Upstream re-LLMs; algorithmic merge + dedup + cap is new |
| 13 | Normalization Pipeline | Upstream passes raw messages; bash-as-first-class + noise filter is new |
| 14 | Supply-Chain Hardening | 16.3 MB → 87 KB package; shrinkwrap for reproducibility |
| 15 | Override by Default | Upstream uses LLM summarizer by default; deterministic is now default |
