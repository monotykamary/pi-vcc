<div align="center">

# 🗜️ pi-vcc

**Algorithmic conversation compactor for [pi](https://github.com/earendil-works/pi-coding-agent)**

_No LLM calls — 35-99% token reduction via extraction and formatting. Same input = same output, always._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

Inspired by [VCC](https://github.com/lllyasviel/VCC) **(View-oriented Conversation Compiler)**.

## Demo

![pi-vcc demo](./demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input = same output, always |
| **Token reduction** | Varies | 35-99% on real sessions (higher on longer sessions) |
| **Compaction latency** | Waits for LLM call | 30-470ms, no API calls |
| **History after compaction** | Gone — agent only sees summary | Active lineage searchable via `vcc_recall` (`scope:"all"` available) |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and accumulate |
| **Cost** | Burns tokens on summarization call | Zero — no API calls |
| **Structure** | Free-form prose | Brief transcript + 7 semantic sections + priority tags + metadata footer |
| **Code awareness** | None (summarizes text only) | Symbol-annotated files, type catalog, deep error extraction |

### Real session metrics

Measured on real session JSONLs under `~/.pi/agent/sessions` (chars = rendered message text).

| Session | Messages | Before | After | Reduction | Time |
|---|---|---|---|---|---|
| Session A | 2,943 | 997,162 | 7,959 | 99.2% | 64ms |
| Session B | 1,703 | 428,334 | 7,762 | 98.2% | 29ms |
| Session C | 1,657 | 424,183 | 9,577 | 97.7% | 54ms |
| Session D | 1,004 | 2,258,477 | 4,439 | 99.8% | 30ms |
| Session E | 486 | 295,006 | 11,163 | 96.2% | 30ms |
| Session F | 46 | 5,234 | 3,364 | 35.7% | 5ms |
| Session G | 27 | 8,595 | 2,489 | 71.0% | 2ms |

## Compaction Deep Dive

pi-vcc is one of four compaction approaches in the AI coding-agent ecosystem. Here is how they compare.

### Pi Default Harness

*Based in `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`*

**Architecture**: LLM-based structured summarization via a summarization model.

**Flow**:
1. `shouldCompact()` — checks if `contextTokens > contextWindow - reserveTokens (16k)`
2. `prepareCompaction()` — walks branch entries, finds previous compaction boundary, calculates cut point by walking newest→oldest accumulating estimated message sizes until hitting `keepRecentTokens` (20k default)
3. `compact()` → `generateSummary()` — serializes conversation to plain text (not LLM messages, to prevent the model from continuing it), calls LLM with structured summarization prompt
4. Two prompt variants: initial `SUMMARIZATION_PROMPT` (first time) or `UPDATE_SUMMARIZATION_PROMPT` (merges into existing summary)
5. Output format: `## Goal / ## Constraints & Preferences / ## Progress / ## Key Decisions / ## Next Steps / ## Critical Context`
6. Detects mid-turn splits — when the cut falls mid-turn, generates a separate turn prefix summary in parallel and merges both
7. Tracks file operations (read/write/edit from tool calls) and appends `<read-files>` / `<modified-files>` XML tags to each summary

**Key characteristics**:
- Pure LLM — every compaction costs a model call
- Token-budget backwalk keeps a configurable tail (20k recent tokens)
- Turn-aware: `isSplitTurn` preserves incomplete assistant turns
- Previous-summary merging via update prompt (incremental)
- Non-deterministic — different runs produce different summaries

---

### Claude Code

*Based in `claude-code/src/services/compact/`*

**Architecture**: Three-tier compaction — proactive/manual (LLM), session memory (LLM-free), and micro-compaction (cache-editing).

**Flow (Main Compaction — `compactConversation()`)** :
1. `shouldAutoCompact()` → `getAutoCompactThreshold()` = context window minus reserved output minus buffer (13k)
2. PreCompact hooks execute (SDK extensions can inject custom instructions)
3. `getCompactPrompt()` builds a prompt with a `NO_TOOLS_PREAMBLE`, a detailed 9-section template, and a trailer rejecting tool calls
4. `streamCompactSummary()` first tries a **cache-sharing fork path** (piggybacks on the main thread's prompt-cache prefix with a forked agent), then falls back to a direct streaming path with only `FileReadTool` + `ToolSearchTool`
5. Strips images/documents from messages before sending to the compact API (replaces with `[image]` / `[document]` markers)
6. PTL (Prompt Too Long) retry: `truncateHeadForPTLRetry()` drops oldest API-round groups and retries (up to 3)
7. After summary generation: creates post-compact file attachments (re-reads recently accessed files), plan attachments, skill attachments, delta tool announcements
8. Executes SessionStart hooks and PostCompact hooks
9. Returns `CompactionResult { boundaryMarker, summaryMessages, attachments, hookResults, messagesToKeep }`

**Flow (Session Memory Compact — `trySessionMemoryCompaction()`)** :
1. Feature-gated: `tengu_session_memory` + `tengu_sm_compact` flags
2. Waits for in-progress session memory extraction to finish
3. `calculateMessagesToKeepIndex()` starts from `lastSummarizedMessageId`, expands backwards to meet `minTokens` (10k) and `minTextBlockMessages` (5), capped at `maxTokens` (40k)
4. `adjustIndexToPreserveAPIInvariants()` ensures tool_use/tool_result pairs are not split (handles streaming message fragmentation)
5. No LLM call — uses already-extracted session memory content as the summary
6. Truncates oversized sections via `truncateSessionMemoryForCompact()`
7. Falls back to legacy compact if session memory is empty or boundary can't be found

**Flow (Micro Compact — `microcompactMessages()`)** :
1. **Time-based trigger**: if the gap since the last main-loop assistant message exceeds the threshold (cold server cache), content-clear old tool results to shrink what gets rewritten
2. **Cached microcompact** (experimental, `CACHED_MICROCOMPACT` feature): tracks tool results per message, queues `cache_edits` blocks for the API layer — removes tool results from the server-side cached prompt without mutating local messages and without invalidating the cached prefix
3. Legacy microcompact (content-clear) fully replaced by the cache-editing approach

**Key characteristics**:
- Three compaction tiers: full LLM / session memory (LLM-free) / micro (cache-edit only)
- Cache-aware: cache-sharing fork path, cache-editing microcompact, PTL retry
- Heavy hook system: 3 hook sets (PreCompact → SessionStart → PostCompact)
- File restoration: re-attaches recently read files post-compact
- Circuit breaker: 3 consecutive failures stops retrying
- Partial compact: supports `up_to` (summarize before, keep prefix) / `from` (summarize after, keep suffix) directions
- Analytics: `tengu_compact` events with full token breakdowns, `analyzeContext()` walks every content block

---

### Codex (OpenAI)

*Based in `codex/codex-rs/core/src/compact.rs`, `compact_remote.rs`, `compact_remote_v2.rs`*

**Architecture**: Rust-based, three concurrent compaction paths — inline (local LLM), remote (server-side), and remote v2 (streaming).

**Flow**:
1. Decision: `should_use_remote_compact_task()` checks whether the provider supports remote compaction
2. Three parallel implementations:

**Inline (local) Path** (`compact.rs`):
1. Pre-hooks → LLM call with a compact prompt → Post-hooks
2. Uses `ContextCompactionItem` — a first-class protocol item embedded in conversation history (not a hack)
3. `COMPACT_USER_MESSAGE_MAX_TOKENS` = 20k token cap
4. `InitialContextInjection` controls when system context is re-injected:
   - `DoNotInject` — for pre-turn/manual compaction (next regular turn handles reinjection)
   - `BeforeLastUserMessage` — for mid-turn compaction (injects above the last real user message)
5. Summarization prompt (from `templates/compact/prompt.md`):
   - "Context checkpoint compaction" handoff summary
   - Key sections: progress, decisions, constraints, remaining work
6. Summary prefix (`templates/compact/summary_prefix.md`): `"Another language model started to solve this problem..."`
7. `trim_function_call_history_to_fit_context_window()` — truncates oversized call histories before compact
8. Event-driven: emits TurnStarted, stream events, TurnCompleted
9. Backoff retry via `codex_util::backoff`

**Remote Path** (`compact_remote.rs`):
1. Delegates compaction to the codex-backend server via the Responses API Compact endpoint
2. Server-side compaction uses OpenAI's own compact infrastructure
3. Client sends history, server returns a `CompactedItem`
4. `process_compacted_history()` replaces conversation items with the compacted version
5. Same hook system (PreCompact → PostCompact) and analytics tracking
6. Logs request/response data via `build_compact_request_log_data()`

**Remote v2 Path** (`compact_remote_v2.rs`):
1. Uses Responses API streaming compact — same endpoint as v1 but leverages the existing `ModelClientSession` for streaming
2. Feature-gated: `Feature::RemoteCompactionV2` (under development, disabled by default)
3. Reuses `process_compacted_history()` and `trim_function_call_history_to_fit_context_window()`
4. Rollout-trace aware: `CompactionCheckpointTracePayload` for end-to-end observability

**Key characteristics**:
- Three parallel compaction implementations: inline / remote / remote-v2
- Server-side compaction can delegate to OpenAI's backend (token savings on the client)
- Rust async with cancellation tokens throughout
- `ContextCompactionItem` is a first-class protocol type, not a synthetic message
- Fine-grained `InitialContextInjection` control over system context reinjection
- Event-driven architecture: full turn lifecycle for compaction (start → stream → complete → error)
- `CompactionAnalyticsAttempt` tracks every phase, status, and implementation

---

### Comparison Summary

| Aspect | Pi Default | pi-vcc | Claude Code | Codex |
|--------|-----------|--------|-------------|-------|
| **Language** | TypeScript (compiled) | TypeScript (extension) | TypeScript (source) | Rust |
| **LLM dependency** | Always required | None | Optional (session memory bypass) | Always (inline) / server-offloaded |
| **Cut strategy** | Token-budget backwalk (20k recent) | Keep last user message | Min tokens (10k) + min text messages (5) | Context window trim |
| **Summary format** | Markdown structured sections `## Goal` etc. | Bracket-tagged sections `[Session Goal]` + `[Anchors]` + `[Earlier Turns]` | `<analysis>` scratchpad + 9-section `<summary>` | Markdown handoff |
| **Merge with prev** | Update prompt (LLM merges) | Header-by-header deterministic dedup | Via session memory (LLM-free) or prompt | Replaces (no merge) |
| **File tracking** | `<read-files>` / `<modified-files>` XML tags | `[Files And Changes]` with symbol annotations | Post-compact file re-attachment (re-reads recent files) | Via server (server-managed) |
| **Turn splitting** | Yes (`isSplitTurn` with parallel prefix summary) | Task-boundary-aware (pushes back on mid-flight turns) | Via `preservedSegment` metadata | Via `InitialContextInjection` |
| **Cache awareness** | None | Section ordering (stable first for prompt cache) | Cache-sharing fork path, cache-editing microcompact, PTL retry | Server-side cache (remote path) |
| **Hook system** | 2 hooks (`session_before_compact`, `session_compact`) | 5 hooks (`session_before_compact`, `session_compact`, `agent_end`, `model_select`, `session_start`) | 3 hooks (PreCompact, SessionStart, PostCompact) | 2 hooks (PreCompact, PostCompact) |
| **Micro compaction** | None | None | Yes (cache-editing + time-based content clear) | None |
| **Partial compact** | None | None | Yes (`up_to` / `from` directions) | None |
| **Error handling** | Basic | Orphan recovery, resolution detection (`[RESOLVED]` tag) | PTL retry (3x), circuit breaker (3 failures) | Backoff retry |
| **Token estimation** | chars/4 heuristic | chars/4 heuristic | `roughTokenCountEstimation` + 4/3 padding | `approx_token_count` |
| **Determinism** | Non-deterministic (LLM) | Deterministic (no LLM) | Non-deterministic (LLM) / deterministic (SM) | Non-deterministic (LLM) / deterministic (server) |
| **Latency** | LLM call time | 2–64ms | LLM call time (or instant with SM/micro) | LLM call time (or server-offloaded) |
| **Cost** | Per-compact LLM tokens | Zero | Per-compact LLM tokens or zero (SM/micro) | Per-compact LLM tokens or server-side |
| **Debugging** | Basic | `/tmp/pi-vcc-debug.json` snapshots | `logForDebugging`, analytics events | Rollout trace, compaction analytics |

## Features

- **No LLM** — purely algorithmic, zero extra API cost
- **Brief transcript** — chronological conversation flow, each tool call collapsed to a one-liner with `(#N)` refs, text truncated to keep it compact
- **8 semantic sections** — session goal, files & changes, type catalog, commits, outstanding context, earlier turns, anchors, user preferences
- **Bounded merge** — rolling sections re-capped after merge instead of growing unbounded
- **Lossless recall** — `vcc_recall` reads raw session JSONL, so active-lineage history stays searchable across compactions
- **Scoped recall** — default search is active lineage; use `scope:"all"` for all lineages, or `scope:"compaction:N"` / `scope:"compaction:latest"` to search within a specific compaction segment's original messages
- **Priority error tags** — outstanding context items tagged `[ERROR]`, `[WARN]`, `[INFO]`, `[RESOLVED]` for urgency at a glance
- **Metadata footer** — each compaction summary ends with timestamp, compression ratio, and message range
- **Compaction counter** — the post-compaction notification reports the ordinal of the just-completed compaction (e.g. `"3rd compaction"`), counted from pi-vcc compaction entries in the session file so it lines up with `scope:"compaction:N"`
- **Cache-friendly ordering** — stable sections (goal, preferences, files, commits, anchors) come first; volatile sections (outstanding context, earlier turns, current status) come last, maximizing prompt-cacheable prefix across compactions
- **Adaptive recall view** — search results grouped by conversation segments (turns) with match indicators (`>`) and context preservation, so the agent sees the conversational structure around each match
- **Regex search** — `vcc_recall` supports regex patterns (`hook|inject`, `fail.*build`) and OR-ranked multi-word queries
- **Result ranking** — search results ranked by BM25 term relevance, rare terms weighted higher than common ones
- **`/pi-vcc-recall`** — slash command to search history directly, results shown as collapsible message and auto-fed to agent as context
- **Fallback cut** — still works when Pi core returns nothing to summarize
- **`/pi-vcc`** — manual compaction on demand
- **Multi-resolution transcript** — three-zone brief: `[Earlier Turns]` (one-liner per conversational turn, heaviest compression), brief transcript (tool calls collapsed, medium compression), and the kept tail (uncompressed). Eliminates the information cliff where older turns vanish entirely.
- **Error resolution detection** — tsc errors in `[Outstanding Context]` are tagged `[RESOLVED]` when the file they reference was subsequently edited, letting the model skip stale errors.
- **Task-boundary-aware cut** — compaction splits at complete conversational turns, not mid-tool-call. If the assistant's response is in-flight (unmatched tool calls), the cut pushes back to keep the whole turn in the tail.
- **Structured anchors** — `[Anchors]` section lists commit hashes, error IDs, and key file paths for zero-tool-call recall. The model can find references at a glance instead of calling `vcc_recall`.
- **Per-model and global compaction thresholds** — configure different `reserveTokens`, `compactAtTokens`, or `compactPercent` per model and globally, so models with different context windows compact at the right time. Proactive triggering on `agent_end` and `model_select` events compacts earlier for small-context models. Applies to both pi-vcc and pi-core compaction.

## Install

```bash
pi install npm:@monotykamary/pi-vcc
```

Or install from GitHub:

```bash
pi install https://github.com/monotykamary/pi-vcc@tom
```

Or try without installing:

```bash
pi -e https://github.com/monotykamary/pi-vcc@tom
```

## Usage

Once installed, pi-vcc registers a `session_before_compact` hook.

- Run `/pi-vcc` to trigger pi-vcc compaction manually.
- By default, pi-vcc handles all compaction paths (`/compact`, auto-threshold, `/pi-vcc`). Set `overrideDefaultCompaction: false` in the config to fall back to pi core's LLM-based compaction for `/compact` and auto-threshold.
- To search older active-lineage history after compaction, use `vcc_recall`.
- To intentionally search across all lineages, pass `scope:"all"` to `vcc_recall` or run `/pi-vcc-recall <query> scope:all`.
- To search and feed results to agent yourself, run `/pi-vcc-recall <query> [page:N]`.
  - Tip: type `/recall` and Pi will autocomplete to `/pi-vcc-recall`.

### How compaction works

Pi splits the conversation at the **last user message**. Everything after — the **kept tail** — stays intact and untouched. pi-vcc only summarizes the older portion before that cut point.

### Compacted message structure

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts (refreshToken, verifyToken, Session)
- Read: src/types.ts (User, AuthPayload)
- Created: tests/auth-refresh.test.ts

[Type Catalog]
- src/auth/session.ts [modified]:
  export function refreshToken(token: string): Promise<Session>
  export function verifyToken(token: string): Promise<User>
  export interface Session {
- src/types.ts [read]:
  export interface User {
  export type AuthPayload = {

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Anchors]
- commits: a1b2c3d
- errors: TS2304
- files: src/auth/session.ts, src/types.ts, tests/auth-refresh.test.ts

[Outstanding Context]
- [RESOLVED] [tsc] src/session.ts(5,18): error TS2304: Cannot find name 'authenticateUser'
- [ERROR] [bash:exit 1] bun test tests/auth.test.ts → 3 tests failed
- [WARN]  [tests] FAIL auth.test.ts > refresh token should work
- [INFO]  [no matches] grep "verifyCredentials"

[Earlier Turns]
- Set up the project structure → read package.json, tsconfig.json
- Install auth dependencies → ran bun add, edited package.json
- Configure the test runner → edited bunfig.toml, ran bun test

[Current Status]
- Working on: fix the auth bug, users can't log in after password reset
- Last action: Edit "src/auth/session.ts"
- Next: need to add the refreshToken function signature

---

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset...
* Read "src/auth/session.ts" (#3)
* Read "src/types.ts" (#5)
* Edit "src/auth/session.ts" (#7)
* bash "bun test tests/auth.test.ts" (#9)
...(28 earlier lines omitted)

---

---
Compaction at 2026-05-18T14:32:00Z — 47 msgs → 23k tok (12x) | tail: 3 msgs ~5.2k tok (range: [#0, #43])

Use `vcc_recall` to search for prior work, decisions, and context from before this summary.
Do not redo work already completed.
```

Sections appear only when relevant — a session with no git commits won't have `[Commits]`.

**Sections:**

| Section | Description |
|---|---|
| `[Session Goal]` | Initial goal + scope changes (regex-based extraction) |
| `[Files And Changes]` | Modified/created/read files from tool calls, annotated with exported symbol names (capped, paths trimmed to common root) |
| `[Type Catalog]` | Exported signature lines from modified and read files — the public API surface the model needs for continuation |
| `[Commits]` | Git commits made during the session (last 8, hash + first line) |
| `[Anchors]` | Structured reference points — commit hashes, error IDs, key file paths — for zero-tool-call recall |
| `[Outstanding Context]` | Unresolved items — error exit codes, test failures, tsc errors, empty search results, pending questions — tagged `[ERROR]`/`[WARN]`/`[INFO]`/`[RESOLVED]` by severity |
| `[Earlier Turns]` | Per-turn one-liner summaries for every conversational turn — heaviest compression layer covering turns that would otherwise fall off the brief transcript |
| `[Current Status]` | Current focus, last file-modifying action, and next steps — extracted from the conversation tail |
| `[User Preferences]` | Regex-extracted from user messages (`always`, `never`, `prefer`...) |
| Brief transcript | Chronological conversation flow — rolling window of ~120 recent lines, tool calls collapsed to one-liners with `(#N)` refs |

**Merge policy:**
- `Session Goal`, `User Preferences`: concise sticky sections
- `Session Goal`, `User Preferences`, `Earlier Turns`: sticky sections that accumulate across compactions (capped)
- `Outstanding Context`, `Type Catalog`, `Current Status`, `Anchors`: volatile (replaced each compaction)
- `Files And Changes`, `Commits`: unique union across compactions
- Brief transcript: rolling window, older lines drop off

### Deep error extraction

`[Outstanding Context]` goes beyond keyword matching. It captures:

| Signal | Format | Example |
|---|---|---|
| Bash non-zero exit code | `[bash:exit N]` | `[bash:exit 1] npm test → 3 tests failed` |
| TypeScript compiler error | `[tsc]` | `[tsc] src/auth.ts(12,5): error TS2322: Type 'string' is not...` |
| Test failure | `[tests]` | `[tests] FAIL auth.test.ts > login should work` |
| Empty grep/glob | `[no matches]` | `[no matches] Grep "verifyCredentials"` |
| Tool error result | `[tool]` | `[bash] Command not found` |
| Blocker text | `[user]` or plain | `[user] The build is still failing with...` |

Items tagged `[RESOLVED]` when the file they reference was subsequently edited — the model can skip them:

```
- [RESOLVED] [tsc] src/auth.ts(5,18): error TS2304: Cannot find name 'authenticateUser'
- [ERROR] [bash:exit 1] bun test tests/api.test.ts → 2 tests failed
```

All items are deduplicated — the same error won't appear twice.

### Symbol-level file annotations

`[Files And Changes]` annotates file paths with exported symbol names extracted from tool call arguments and results:

```
- Modified: src/auth.ts (login, verifyToken, Session)
- Read: src/types.ts (User, AuthPayload)
```

Supported languages: TypeScript/JavaScript (`export function/class/type/interface`), Python (`def`/`class`), Go (`func`, exported only), Rust (`pub fn/struct/enum/trait`).

### Type catalog

`[Type Catalog]` captures the exact exported signature lines from modified and read files. This gives the compacted model the type signatures it needs to continue coding — without re-reading files.

Modified files appear first, read files second. Entries are capped at 8 signatures per file and 12 files total.

## Recall (Lossless History)

Pi's default compaction discards old messages permanently. After compaction, the agent only sees the summary.

`vcc_recall` bypasses this by reading the raw session JSONL file directly. By default it searches only the active conversation lineage, regardless of how many compactions have happened. Use `scope:"all"` only when you intentionally want to include off-lineage branches.

### Adaptive View (Structure-Preserving Search Results)

Search results are grouped by **conversation segments** (turns) instead of showing flat ranked entries. Each segment starts at a user or bash message and includes all subsequent assistant responses, tool calls, and tool results.

Matched entries are marked with `>`, non-matched entries within the same segment are shown for context:

```
vcc_recall({ query: "auth bug" })
```

Returns:
```
Found 4 matches for "auth bug" — 2 matches across 1 segment

--- #12-#17 (2/6 entries match) ---
> #12 [user] I found an auth bug in the login flow
  #13 [assistant] Let me check the auth module...
  #14 [tool_call] Read src/auth.ts
  #15 [tool_result] export function login...
> #16 [assistant] The bug is in refreshToken
  #17 [tool_result] Edit src/auth.ts (success)
```

When matches span multiple segments, adjacent non-matching turns are shown with a `(context)` tag:

```
Found 3 matches for "cache" — 2 matches across 2 segments

--- #5-#8 (1/4 entries match) ---
  #5 [user] add caching to the API layer
  #6 [assistant] I'll set up Redis...
  #7 [tool_call] Edit src/cache.ts
> #8 [tool_result] Redis connected successfully

--- #20-#23 (1/4 entries match) ---
> #20 [user] the cache eviction policy is wrong
  #21 [assistant] Let me check the TTL config...
  #22 [tool_call] Read src/cache.ts
  #23 [tool_result] export const TTL = 3600

--- #9-#19 (context) ---
  #9 [user] also fix the error handling
  #10 [assistant] Added try/catch around cache calls
```

This format preserves the conversational structure around matches, so the agent can understand *where* in the conversation flow each match occurred and what context surrounds it.

### Search

Queries support **regex** and **multi-word OR logic** ranked by relevance:

```
vcc_recall({ query: "auth token" })                                    // active-lineage OR search, ranked
vcc_recall({ query: "auth token", page: 2 })                           // paginated (5 results/page)
vcc_recall({ query: "hook|inject" })                                    // regex pattern
vcc_recall({ query: "fail.*build" })                                    // regex pattern
vcc_recall({ query: "auth token", scope: "all" })                      // search all lineages
vcc_recall({ query: "race condition", scope: "compaction:2" })         // search within compaction #2's segment
vcc_recall({ query: "design rationale", scope: "compaction:latest" })  // search most recent compaction segment
```

Compaction-scoped search targets only the original messages that were summarized by that compaction cycle. This lets you drill into specific conversation segments without sifting through unrelated chat.

Manual slash command:

```
/pi-vcc-recall auth token scope:all
/pi-vcc-recall race condition scope:compaction:latest
```

### Browse

Without a query, returns the last 25 entries as brief summaries:

```
vcc_recall()
vcc_recall({ scope: "all" })  // browse recent entries across all lineages
```

### Expand

Returns full untruncated content for specific indices found via search:

```
vcc_recall({ expand: [41, 42] })                 // active-lineage expand
vcc_recall({ expand: [41, 42], scope: "all" })   // expand across all lineages
```

Typical workflow: **search → find relevant entry indices → expand those indices for full content**.

> Some tool results are truncated by Pi core at save time. `expand` returns everything in the JSONL but can't recover what Pi already cut.

## Performance

pi-vcc processes 3.7 MB sessions (2,600 messages, 3,000 blocks) in **~31 ms** — no LLM calls, no I/O waits beyond reading the session JSONL. Below are the optimizations that got us there.

### Pipeline profile (3.7 MB session)

| Stage | Time | % of total |
|---|---|---|
| `normalize` | 4 ms | 13% |
| `filterNoise` | <1 ms | <1% |
| `buildToolResultIndex` | <1 ms | <1% |
| **`extractFileAndSymbolData`** | **23 ms** | **74%** |
| Other extractors | <1 ms | <1% |
| `buildBriefSections` | 1 ms | 4% |
| `formatSummary` + merge | ~2 ms | 7% |
| **Total** | **~31 ms** | |

### Optimizations

#### Catastrophic backtracking fix (`C_FUNC_RE`)

The C/C++ function-declaration regex used a repeated group `(?:\w+(?:\s*[*&]+\s*)?)+` that triggered exponential backtracking on long non-matching identifiers (e.g. `createAssistantMessageEventStream`). A single pathological line took **1.2 s**; a session with many such lines could stall compaction for seconds.

Replaced with a lazy-quantifier pattern `\w[\w:*&\s]*?` and a negative lookahead to skip Go `func` lines. The same line now takes **<0.1 ms** — a **>1000×** speedup. This was the root cause of the original "slow compaction" report on 170k-token sessions.

#### Unified symbol extraction (`extractFileAndSymbolData`)

Previously, three independent extractors (`extractFiles`, `extractSymbolChanges`, `extractTypeCatalog`) each scanned the same tool results with overlapping regex patterns — a **triple-redundant parse**. The unified `extractFileAndSymbolData()` in `shared-symbols.ts` does it once and feeds all three consumers from a single pass.

Also added `ToolResultIndex` and `buildToolResultIndex()` to pre-compute the tool_call → tool_result look-ahead map once, shared across all extractors instead of each scanning forward independently.

#### `DECL_SCREEN_RE` pre-filter

Each line was tested against a 15-regex cascade to find declaration names. ~60% of lines in a real session are body code, comments, or blank — none can match, yet every line ran all 15 tests.

`DECL_SCREEN_RE` is a single anchored regex that rejects non-declaration lines in one test. Matching lines then fall through to the full cascade. Measured at **2.6× faster** for the `parseDeclName` stage.

#### `eachLine()` generator replaces `split().slice()`

`extractSymbolsFromText` used `text.split("\n").slice(0, N)` to read the first N lines — allocating a full temporary string array every call. Over 600+ tool results in a large session, this added up to ~18 ms of allocation overhead.

Replaced with an `eachLine()` generator using `indexOf("\n")` + `slice()` — zero intermediate array allocation. Produces identical iteration behavior.

#### `Set`-based dedup replaces `Array.includes()`

Symbol dedup used `Array.includes()` on value arrays that grew to 200+ entries per file — O(n) per check. A parallel `Map<string, Set<string>>` makes dedup O(1). Measured at **5.7× faster** for dedup operations.

#### `Intl.Segmenter` → regex word split

`brief.ts` used `Intl.Segmenter` for token-aware truncation, which allocated granular objects per word. Replaced with `\p{L}[\p{L}\p{N}]*|\p{N}+` regex — identical output, ~2× faster, zero object allocation.

#### `convertToLlm()` elimination

The `before-compact` hook called `convertToLlm()` to transform messages into an LLM message format before processing. Since pi-vcc processes messages algorithmically via `normalize()` (which already handles `user`, `assistant`, `toolResult`, and `bashExecution` directly), this conversion was both lossy (flattened bash `command`/`output`/`exitCode` into plain text) and wasteful. Removed entirely.

#### Missing `read` in `FILE_READ_TOOLS`

pi's built-in file-read tool uses the lowercase `read` tool name, but `FILE_READ_TOOLS` only contained `Read`. All read operations were invisible to file-activity and symbol extraction — a correctness fix, not strictly a performance fix, but it meant the symbol extractor was silently skipping data it should have processed.

### Summary

| Optimization | Impact |
|---|---|
| `C_FUNC_RE` backtracking fix | 1.2 s → <0.1 ms per line (>1000×) |
| Unified symbol extraction | 3× fewer redundant scans |
| `DECL_SCREEN_RE` pre-filter | 2.6× faster `parseDeclName` |
| `eachLine()` generator | ~18 ms saved on large sessions |
| `Set`-based dedup | 5.7× faster symbol dedup |
| Regex word split | 2× faster token truncation |
| `convertToLlm()` removal | Eliminated redundant message conversion |

## Pipeline

1. **Normalize** — raw Pi messages → uniform blocks (user, assistant, tool_call, tool_result, thinking, bash)
2. **Filter noise** — strip system messages, empty blocks, noise tools (TodoWrite, etc.)
3. **Build sections** — extract goal, file paths + symbols, type catalog, blockers (exit codes, tsc, tests, empty grep), preferences
4. **Brief transcript** — chronological conversation flow, tool calls collapsed to one-liners, text truncated
5. **Format** — render into bracketed sections + transcript, with cache-friendly ordering (stable sections first, volatile last)
6. **Merge** — if previous summary exists: sticky sections merge, volatile sections replace, transcript rolls
7. **Footer** — append timestamp, compression ratio, message range, and recall note

## Config

Config lives at `~/.pi/agent/pi-vcc-config.json` (auto-scaffolded on first load with safe defaults):

```json
{
  "overrideDefaultCompaction": true,
  "debug": false,
  "modelThresholds": {
    "neuralwatt/zai-org/GLM-5.1-FP8": { "reserveTokens": 32768 },
    "neuralwatt/moonshotai/Kimi-K2.6": { "compactPercent": 65 },
    "neuralwatt/glm-5.1-long": { "compactAtTokens": 150000 }
  },
  "globalThreshold": { "compactAtTokens": 150000 }
}
```

- **`overrideDefaultCompaction`** *(default `true`)*: when `true` (default), pi-vcc handles all compaction paths (`/compact`, auto-threshold, `/pi-vcc`). Set `false` to let pi core handle `/compact` and auto-threshold compactions via its default LLM-based compaction.
- **`debug`** *(default `false`)*: when `true`, each compaction writes detailed info to `/tmp/pi-vcc-debug.json` — message counts, cut boundary, summary preview, sections.
- **`modelThresholds`** *(default: none)*: per-model compaction thresholds. Keys match against `"provider/modelId"` (e.g., `"neuralwatt/zai-org/GLM-5.1-FP8"`) or just `"modelId"` (e.g., `"GLM-5.1"` — matched only when `provider/modelId` doesn't). Each value has:
  - **`reserveTokens`**: tokens to reserve for the LLM response. Overrides pi-core's global `compaction.reserveTokens` for matching models. Controls *when* compaction triggers: `contextTokens > contextWindow − reserveTokens`. A higher value compacts earlier (more conservative); a lower value lets context grow larger. Takes precedence over `compactAtTokens` and `compactPercent` when multiple are set.
  - **`compactAtTokens`**: absolute context token count where compaction triggers: `contextTokens > compactAtTokens`. Useful when you want the same trigger point across models with different context windows, such as `{ "compactAtTokens": 150000 }`. Takes precedence over `compactPercent` when both are set.
  - **`compactPercent`**: compaction trigger as a percentage of context window (1–99). Compaction fires when `contextTokens > contextWindow × compactPercent / 100`. E.g. `65` means "compact when context is 65% full". Ignored when `reserveTokens` or `compactAtTokens` is also set.
  - **`keepRecentTokens`** *(optional)*: advisory token budget for pi-core's default compaction. Pi-vcc's own `buildOwnCut` uses task-boundary heuristics, so this only affects pi-core's cut when `overrideDefaultCompaction` is `false`.
- **`globalThreshold`** *(default: none)*: global threshold applied to all models not matched by `modelThresholds`. Uses `reserveTokens`, `compactAtTokens`, or `compactPercent`. If omitted, pi-core's global `compaction.reserveTokens` applies (no override).
- **`defaultThreshold`** *(default: none, deprecated)*: use `globalThreshold` instead. Backward compatible — still works.

### How compaction thresholds work

Pi-core's auto-compaction triggers when `contextTokens > contextWindow − reserveTokens`. The global `reserveTokens` (default 16384) is one-size-fits-all — but different models have very different context windows and cost profiles. Pi-vcc also supports `compactAtTokens` when you want an absolute trigger point independent of a model's context window.

Pi-vcc's thresholds provide proactive compaction at both the per-model and global level:

| Direction | How it works |
|---|---|
| **Compact earlier** (model needs compaction sooner) | `agent_end` and `model_select` proactively trigger compaction when context exceeds the model's threshold but hasn't hit the global threshold yet. The `globalThreshold` also proactively triggers for unmatched models. |

Previously, a "compact later" direction was implemented by cancelling compaction in `session_before_compact` when context was below the per-model threshold. This guard was removed because `session_before_compact` carries no reason field — manual `/compact` and auto-compaction are indistinguishable (both have `customInstructions: undefined`), so the guard was blocking explicit user compaction requests.

The proactive trigger handles the "compact earlier" direction. If pi-core's global threshold fires before the per-model threshold is crossed, the compaction proceeds — slightly premature from the per-model threshold's perspective, but preferable to blocking an explicit user action.

Key matching order: exact `"provider/modelId"` → `"modelId"` → `globalThreshold` → pi-core's global setting.

Explicit `/pi-vcc` commands bypass threshold checks — if you ask for compaction, you get it.

## Related Work

- [VCC](https://github.com/lllyasviel/VCC) — the original transcript-preserving conversation compiler
- [Pi](https://github.com/badlogic/pi-mono) — the AI coding agent this extension is built for
- [DeepSeek-V4](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/DeepSeek_V4.pdf) — hybrid attention architecture that directly inspired pi-vcc's multi-resolution transcript, resolution detection, task-boundary cut, and anchors
- [Mastra](https://mastra.ai) — Observational Memory patterns that inspired Current Status, priority error tags, cache-friendly ordering, and compaction-scoped recall
- [Claude Code](https://github.com/anthropics/claude-code) — three-tier compaction architecture (LLM / session memory / micro-compact) that influenced cache-friendly ordering and compaction-scoped recall design
- [Codex (OpenAI)](https://github.com/openai/codex) — Rust-based three-path compaction that inspired the handoff preamble and first-class structured compaction output
- [VCC Paper](https://arxiv.org/abs/2603.29678) — adaptive view concept that inspired structure-preserving search results and thinking content surfacing in recall

### Inspirations & Attribution

This fork builds on the upstream `sting8k/pi-vcc` with novel features inspired by five external projects. Below is a comprehensive mapping of each inspiration source to the features it produced.

#### DeepSeek-V4 — Hybrid Attention Architecture

Inspired by DeepSeek-V4's CSA/HCA/SWA attention architecture, Lightning Indexer, Attention Sink, Quick Instruction, and contextual parallelism.

| DeepSeek-V4 Technique | pi-vcc Equivalent | Shared Principle |
|---|---|---|
| **CSA** (light compression, m=4) | `[Files And Changes]`, `[Type Catalog]` | Medium-fidelity: keeps structure but drops full content |
| **HCA** (heavy compression, m'=128) | `[Earlier Turns]` | Heaviest compression: one-liner per conversational turn |
| **Sliding Window Attention** (n_win=128) | Brief transcript rolling window + `[Current Status]` | Uncompressed recent context for local fidelity |
| **Lightning Indexer** (top-k sparse selection) | `vcc_recall` (BM25 + regex) | Selective, not exhaustive, access to compressed memory |
| **Attention Sink** (near-zero on stale entries) | `[RESOLVED]` tag on fixed errors | Let the consumer gracefully ignore stale compressed context |
| **On-disk KV cache** (prefix reuse) | Raw JSONL recall via `vcc_recall` | Lossless cold store alongside compressed hot context |
| **Quick Instruction** (cache reuse for aux tasks) | `[Anchors]` (zero-tool-call recall) | Self-serve lookups from already-present context |
| **Contextual Parallelism** (boundary alignment) | Task-boundary-aware cut | Compression segments align to meaningful units, not arbitrary positions |
| **Hybrid precision** (BF16+FP8, cache-aligned) | Cache-friendly section ordering | Stable prefix survives across compactions for prompt caching |
| **Interleaved thinking preservation** | Brief transcript preservation | Discarding intermediate reasoning forces reconstruction from scratch |

**Features delivered:**
1. **Multi-resolution transcript** — three-zone brief: `[Earlier Turns]` (one-liner/turn), brief transcript (medium compression), kept tail (uncompressed)
2. **Error resolution detection** — tsc errors tagged `[RESOLVED]` when the file they reference was subsequently edited
3. **Task-boundary-aware cut** — cut point detects mid-flight turns and pushes back to keep the whole turn in the tail
4. **Structured anchors** — `[Anchors]` section with commit hashes, error IDs, key file paths for zero-tool-call recall

#### Mastra — Observational Memory

Inspired by Mastra's OM patterns — treating compaction output as a structured observation layer rather than free-form prose.

| Mastra OM Pattern | pi-vcc Equivalent |
|---|---|
| Observational memory summary | `[Current Status]` section — auto-extracted focus, last action, next steps |
| Priority-tagged observations | `[ERROR]`/`[WARN]`/`[INFO]`/`[RESOLVED]` tags on Outstanding Context |
| Stable-first observation ordering | Cache-friendly section ordering (stable sections first, volatile last) |
| Per-observation metadata | Timestamp + compression-ratio metadata footer |
| Scoped observation retrieval | Compaction-scoped `vcc_recall` (`scope:'compaction:N'`) |

#### Claude Code — Three-Tier Compaction

Claude Code's three-tier architecture (full LLM, session memory = LLM-free, micro-compact = cache-editing) influenced pragmatic design choices:

| Claude Code Technique | pi-vcc Influence |
|---|---|
| Cache-sharing fork path | Cache-friendly section ordering — stable prefix survives across compactions for prompt cache hits |
| `lastSummarizedMessageId` boundary tracking | Compaction-scoped recall — `scope:'compaction:N'` drills into specific segments |
| Session memory (deterministic, LLM-free) | Validates the zero-LLM approach; pi-vcc achieves similar determinism via extraction instead of a separate memory pipeline |

#### Codex (OpenAI) — Three-Path Compaction

Codex's Rust-based compaction (inline/remote/remote-v2) inspired higher-level design decisions:

| Codex Technique | pi-vcc Influence |
|---|---|
| `summary_prefix.md` continuation directive | Handoff preamble — continuation directive prepended to every compaction summary |
| `ContextCompactionItem` as first-class protocol type | Structured bracket-tagged sections act as a first-class compaction artifact, not free-form prose |
| `InitialContextInjection` control over system context | Task-boundary-aware cut ensures meaningful boundaries, not arbitrary splits |

#### VCC Paper — Adaptive View

The original VCC paper (arxiv.org/abs/2603.29678) introduced the adaptive view concept — preserving conversation structure and role tags in search projections.

| VCC Paper Concept | pi-vcc Equivalent |
|---|---|
| Adaptive view (structure-preserving projection) | Structure-preserving search results — grouped by conversation segments (turns) with `>` match indicators |
| Role tag preservation | Thinking content surfacing — `thinkingOf()` extracts model reasoning for recall display and search indexing |

#### Original Novel Work

Features with no external inspiration — original engineering contributions unique to this fork:

1. **Deep error extraction** — captures bash exit codes `[bash:exit N]`, tsc errors `[tsc]`, test failures `[tests]`, empty grep/glob `[no matches]` with structured tags and dedup
2. **Symbol-annotated files** — file paths annotated with exported symbol names extracted from tool call arguments and results
3. **Type catalog** — `[Type Catalog]` section with exact exported signature lines from modified/read files
4. **Multi-language symbol extraction** — Rust, Java, C/C++, Zig, Ruby, Elixir symbol detection with language-specific regex patterns
5. **Performance optimization suite** — catastrophic backtracking fix (>1000×), unified extraction (3×), DECL_SCREEN_RE pre-filter (2.6×), eachLine() generator, Set-based dedup (5.7×), Intl.Segmenter replacement (2×), convertToLlm() elimination
6. **Entry-ID-based message range** — stores entry IDs instead of branch-relative indices for correct cross-branch resolution
7. **Neuralwatt-MCR interop** — signals compaction override so MCR models don't discard pi-vcc's summary
8. **Supply-chain hardening** — pinned deps, npm-shrinkwrap, audit fixes

## License

MIT
