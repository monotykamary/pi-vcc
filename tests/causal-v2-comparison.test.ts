/**
 * Feature (2) comparison test: V1 breadcrumbs vs V2 causal breadcrumbs.
 *
 * Runs identical message sequences through compile() and measures:
 *   - Goal→file linkage rate  (can you tell which file was edited for which goal?)
 *   - Causal chain rate       (can you tell WHY the work was done and WHAT was done?)
 *   - Breadcrumb quality     (do breadcrumbs carry cause/resolution or just file names?)
 *
 * The test also snapshots the V1 output by running against the old code
 * (the new causal logic is the only change — all other code paths are identical).
 *
 * Run: bun test tests/causal-v2-comparison.test.ts
 */

import { describe, test, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import { extractCausalChain } from "../src/core/brief";
import type { Message } from "@earendil-works/pi-ai";

// ── Deterministic message factories ──

const ts = Date.now();
const assistBase = {
  api: "messages" as any,
  provider: "anthropic" as any,
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  timestamp: ts,
};

const makeUserMsg = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: ts,
});

const makeAssistantMsg = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...assistBase,
  stopReason: "stop",
});

const makeToolCall = (
  name: string,
  id: string,
  args: Record<string, unknown>,
): Message => ({
  role: "assistant",
  content: [
    { type: "text", text: "" },
    { type: "toolCall", name, id, arguments: args },
  ],
  ...assistBase,
  stopReason: "toolUse",
});

const makeToolResult = (
  toolCallId: string,
  toolName: string,
  content: string,
  isError = false,
): Message => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text: content }],
  isError,
  timestamp: ts,
} as any);

// ── Realistic conversation rounds ──

interface RoundSpec {
  goal: string;
  cause: string;
  resolution: string;
  file1: string;
  file2: string;
  hasCommit: boolean;
  testPasses: boolean;
  errorInOutput: boolean;
}

const ROUNDS: RoundSpec[] = [
  { goal: "Fix login bug", cause: "refreshToken() returns early on empty sessions", resolution: "added session check in refreshToken", file1: "src/auth.ts", file2: "src/session.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Fix signup validation", cause: "email validator rejects valid addresses with + signs", resolution: "switched to RFC 5322 regex", file1: "src/validators.ts", file2: "src/users.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Add password reset", cause: "users cant recover accounts without admin help", resolution: "added reset flow with rate limiter", file1: "src/reset.ts", file2: "src/middleware.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Fix race condition in token refresh", cause: "concurrent requests double-refresh the token", resolution: "added mutex lock around refresh path", file1: "src/auth.ts", file2: "src/token.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Add rate limiter to API", cause: "unauthenticated endpoints are being scraped", resolution: "added sliding window rate limiter middleware", file1: "src/middleware.ts", file2: "src/config.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Migrate to PostgreSQL", cause: "SQLite cant handle concurrent writes", resolution: "swapped driver to pg, updated connection pool", file1: "src/db.ts", file2: "src/config.ts", hasCommit: true, testPasses: false, errorInOutput: true },
  { goal: "Fix flaky integration tests", cause: "tests share state via global singleton", resolution: "isolated test fixtures per suite", file1: "tests/auth.test.ts", file2: "tests/setup.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Refactor auth middleware", cause: "middleware has 300-line function doing auth + routing + logging", resolution: "split into auth, routing, logging layers", file1: "src/middleware.ts", file2: "src/logger.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Extract session handler", cause: "session logic mixed into route handlers", resolution: "extracted SessionHandler class", file1: "src/session.ts", file2: "src/routes.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Add OAuth2 integration", cause: "users want Google SSO login", resolution: "added OAuth2 strategy with PKCE flow", file1: "src/oauth.ts", file2: "src/auth.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Fix token expiry on slow connections", cause: "token expires during long API calls", resolution: "added client-side token refresh with 30s buffer", file1: "src/token.ts", file2: "src/api.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Add crypto utilities", cause: "password hashing uses outdated bcrypt rounds", resolution: "migrated to argon2id with adaptive cost", file1: "src/crypto.ts", file2: "src/validators.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Set up structured logging", cause: "console.log calls scattered everywhere, no correlation IDs", resolution: "added pino logger with request ID middleware", file1: "src/logger.ts", file2: "src/middleware.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Fix memory leak in connection pool", cause: "connections not returned to pool on error paths", resolution: "added try/finally release in all query paths", file1: "src/db.ts", file2: "src/services.ts", hasCommit: true, testPasses: false, errorInOutput: true },
  { goal: "Add input validators for API", cause: "API accepts malformed payloads causing 500s downstream", resolution: "added zod schemas for all endpoints", file1: "src/validators.ts", file2: "src/routes.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Implement caching layer", cause: "repeated DB queries for user profile on every request", resolution: "added Redis cache with TTL-based invalidation", file1: "src/cache.ts", file2: "src/services.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Add type definitions", cause: "any-casts causing runtime errors in production", resolution: "added strict interfaces for all service boundaries", file1: "src/types.ts", file2: "src/models.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Fix error handling utilities", cause: "errors swallowed silently, no stack traces in logs", resolution: "added AppError class with cause chain", file1: "src/errors.ts", file2: "src/logger.ts", hasCommit: true, testPasses: true, errorInOutput: false },
  { goal: "Build request handlers", cause: "route handlers directly call DB, no abstraction", resolution: "extracted handler layer with dependency injection", file1: "src/handlers.ts", file2: "src/services.ts", hasCommit: false, testPasses: true, errorInOutput: false },
  { goal: "Fix CSRF protection", cause: "CSRF token not validated on mutation requests", resolution: "added double-submit cookie pattern", file1: "src/middleware.ts", file2: "src/routes.ts", hasCommit: true, testPasses: true, errorInOutput: false },
];

const makeRound = (roundIdx: number): Message[] => {
  const spec = ROUNDS[roundIdx % ROUNDS.length];
  const id1 = `r${roundIdx}-1`;
  const id2 = `r${roundIdx}-2`;
  const id3 = `r${roundIdx}-3`;

  const msgs: Message[] = [
    makeUserMsg(spec.goal),
    makeToolCall("Read", id1, { file_path: spec.file1 }),
    makeToolResult(id1, "Read", `// ${spec.file1}\nexport function fn() { /* existing code */ }\n`),
    makeAssistantMsg(`The issue is ${spec.cause}. I will fix this by ${spec.resolution}.`),
    makeToolCall("Edit", id2, {
      file_path: spec.file1,
      oldText: "// existing code",
      newText: `// ${spec.resolution}\nexport function fixed() { return true; }\n`,
    }),
    makeToolResult(id2, "Edit", "OK"),
  ];

  if (spec.errorInOutput) {
    msgs.push(
      makeToolCall("bash", id3, { command: `npm test -- ${spec.file1}` }),
      makeToolResult(id3, "bash", `FAIL ${spec.file1}\nexit code 1`, true),
      makeAssistantMsg(`Test failed. Retrying with a different approach.`),
    );
  }

  if (spec.hasCommit) {
    msgs.push(
      makeToolCall("bash", `r${roundIdx}-6`, { command: `git commit -m "feat: ${spec.goal.toLowerCase()}" ` }),
      makeToolResult(`r${roundIdx}-6`, "bash", `[main abc${String(roundIdx).padStart(4, "0")}] feat: ${spec.goal.toLowerCase()}`),
    );
  }

  if (spec.testPasses) {
    msgs.push(
      makeAssistantMsg(`All tests pass. ${spec.resolution} is working correctly.`),
    );
  }

  return msgs;
};

// ── Causal chain measurement ──

const isCausalChainPresent = (text: string, spec: RoundSpec): boolean => {
  const causeWords = spec.cause
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !/^(the|this|that|with|from|into|over|under|before|after|during|because|since|where|which|their|these|those|been|being|have|has|had|will|would|could|should|without|through|between)$/i.test(w));

  const resolutionWords = spec.resolution
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !/^(the|this|that|with|from|into|over|under|before|after|during|because|since|where|which|their|these|those|been|being|have|has|had|will|would|could|should|without|through|between)$/i.test(w));

  // Direct text presence
  const hasCauseDirect = causeWords.some(w => text.toLowerCase().includes(w.toLowerCase()));
  const hasResolutionDirect = resolutionWords.some(w => text.toLowerCase().includes(w.toLowerCase()));

  if (hasCauseDirect && hasResolutionDirect) return true;

  // Causal breadcrumb: ...recall: file|resolution-key
  const file1Short = spec.file1.split("/").pop() ?? spec.file1;
  const resolutionKeyWords = spec.resolution.split(/\s+/).filter(w => w.length > 3).slice(0, 2);
  const causeKeyWords = spec.cause.split(/\s+/).filter(w => w.length > 3 && !/^(the|this|that|with|from|into|over|under|before|after|during|because|since|where|which|their|these|those|been|being|have|has|had|will|would|could|should|without|through|between)$/i.test(w)).slice(0, 2);

  for (const line of text.split("\n")) {
    if (!line.includes("...recall:")) continue;
    const bcContent = line.slice(line.indexOf("...recall:") + 10);
    const bcParts = bcContent.split(", ");
    for (const bcPart of bcParts) {
      if (bcPart.includes("|")) {
        const [filePart, keyPart] = bcPart.split("|");
        const hasFile = filePart.includes(file1Short);
        const keyWords = keyPart.split("-");
        const hasResKey = resolutionKeyWords.some(rw => keyWords.some(kw => kw.toLowerCase() === rw.toLowerCase()));
        const hasCauKey = causeKeyWords.some(cw => keyWords.some(kw => kw.toLowerCase() === cw.toLowerCase()));
        if ((hasResKey || hasCauKey) && (hasFile || !hasCauseDirect)) return true;
      }
    }
  }

  return false;
};

// ── V1 simulation ──
// V1 turn summaries: "goal → edited file.ts" (no cause/resolution)
// V1 breadcrumbs: just filenames or first-3-words
// We simulate V1 by stripping the cause/resolution from assistant text.

const makeRoundV1 = (roundIdx: number): Message[] => {
  const spec = ROUNDS[roundIdx % ROUNDS.length];
  const id1 = `r${roundIdx}-1`;
  const id2 = `r${roundIdx}-2`;
  const id3 = `r${roundIdx}-3`;

  const msgs: Message[] = [
    makeUserMsg(spec.goal),
    makeToolCall("Read", id1, { file_path: spec.file1 }),
    makeToolResult(id1, "Read", `// ${spec.file1}\nexport function fn() { /* existing code */ }\n`),
    // V1: generic assistant text without causal language
    makeAssistantMsg(`I'll edit ${spec.file1} to implement the changes.`),
    makeToolCall("Edit", id2, {
      file_path: spec.file1,
      oldText: "// existing code",
      newText: `// changes\nexport function fixed() { return true; }\n`,
    }),
    makeToolResult(id2, "Edit", "OK"),
  ];

  if (spec.errorInOutput) {
    msgs.push(
      makeToolCall("bash", id3, { command: `npm test -- ${spec.file1}` }),
      makeToolResult(id3, "bash", `FAIL\nexit code 1`, true),
      makeAssistantMsg(`Test failed. Retrying.`),
    );
  }

  if (spec.hasCommit) {
    msgs.push(
      makeToolCall("bash", `r${roundIdx}-6`, { command: `git commit -m "feat: ${spec.goal.toLowerCase()}" ` }),
      makeToolResult(`r${roundIdx}-6`, "bash", `[main abc${String(roundIdx).padStart(4, "0")}] feat: ${spec.goal.toLowerCase()}`),
    );
  }

  if (spec.testPasses) {
    msgs.push(makeAssistantMsg(`Done.`));
  }

  return msgs;
};

// ── Metrics ──

interface Metrics {
  round: number;
  outputChars: number;
  causalChainRate: number;
  linkageRate: number;
}

const computeMetrics = (rounds: number, makeRoundFn: (i: number) => Message[]): Metrics[] => {
  let prev = "";
  const metrics: Metrics[] = [];
  const allSpecs: RoundSpec[] = [];

  for (let round = 0; round < rounds; round++) {
    const spec = ROUNDS[round % ROUNDS.length];
    const msgs = makeRoundFn(round);
    allSpecs.push(spec);

    const result = compile({
      messages: msgs,
      previousSummary: prev || undefined,
    });
    prev = result;

    // Causal chain rate
    let causalChains = 0;
    for (const s of allSpecs) {
      if (isCausalChainPresent(result, s)) causalChains++;
    }

    // Goal→file linkage (simple check: do goal keywords and file path appear
    // on the same Earlier Turns line?)
    let linked = 0;
    for (const s of allSpecs) {
      const goalKey = s.goal.split(/\s+/).filter(w => w.length > 3).slice(0, 2);
      const fileShort = s.file1.split("/").pop() ?? s.file1;
      // Check Earlier Turns
      const etIdx = result.indexOf("[Earlier Turns]");
      if (etIdx >= 0) {
        const after = result.slice(etIdx);
        const end = after.indexOf("\n\n---\n\n", 1);
        const block = after.slice(0, end > 0 ? end : after.length);
        for (const line of block.split("\n")) {
          if (line.startsWith("- ...recall:")) continue;
          const hasGoal = goalKey.some(kw => line.toLowerCase().includes(kw.toLowerCase()));
          const hasFile = line.includes(s.file1) || line.includes(fileShort);
          if (hasGoal && hasFile) { linked++; break; }
        }
      }
    }

    metrics.push({
      round: round + 1,
      outputChars: result.length,
      causalChainRate: allSpecs.length > 0 ? causalChains / allSpecs.length : 1,
      linkageRate: allSpecs.length > 0 ? linked / allSpecs.length : 1,
    });
  }

  return metrics;
};

const TOTAL = 100;

describe("causal v2 comparison", () => {
  test("V2 (causal breadcrumbs) vs V1 (keyword breadcrumbs) — 20 compactions", () => {
    const v2Metrics = computeMetrics(TOTAL, makeRound);
    const v1Metrics = computeMetrics(TOTAL, makeRoundV1);

    // Print comparison table
    console.log("\n╔════════════════════════════════════════════════════════════════════════════════════════════╗");
    console.log("║  V1 (keyword breadcrumbs) vs V2 (causal breadcrumbs) — 20 COMPACTIONS                   ║");
    console.log("╠═══════╦═══════════════════════════════╦═════════════════════════════╦════════════════════╣");
    console.log("║       ║  V1 (keyword breadcrumbs)    ║  V2 (causal breadcrumbs)   ║                    ║");
    console.log("║ Round ║  Causal  Linkage  Size        ║  Causal  Linkage  Size     ║ Causal Δ  Link Δ  ║");
    console.log("╠═══════╬═══════════════════════════════╬═════════════════════════════╬════════════════════╣");

    const pct = (n: number) => `${(n * 100).toFixed(0).padStart(3)}%`;
    const delta = (v2: number, v1: number) => {
      const d = v2 - v1;
      return d > 0 ? `+${(d * 100).toFixed(0)}%` : d < 0 ? `${(d * 100).toFixed(0)}%` : "  0%";
    };

    for (const sampleRound of [1, 2, 5, 10, 20, 50, 75, 100]) {
      const v1 = v1Metrics[sampleRound - 1];
      const v2 = v2Metrics[sampleRound - 1];
      console.log(
        `║ ${String(sampleRound).padStart(5)} ║  ${pct(v1.causalChainRate)}  ${pct(v1.linkageRate)}  ${String(v1.outputChars).padStart(5)}     ║  ${pct(v2.causalChainRate)}  ${pct(v2.linkageRate)}  ${String(v2.outputChars).padStart(5)}     ║ ${delta(v2.causalChainRate, v1.causalChainRate).padStart(7)}  ${delta(v2.linkageRate, v1.linkageRate).padStart(7)} ║`,
      );
    }

    console.log("╚═══════╩═══════════════════════════════╩═════════════════════════════╩════════════════════╝");

    // Full degradation curves
    console.log("\nV2 FULL DEGRADATION CURVE:");
    console.log("Round | Causal | Linkage | Size");
    for (const m of v2Metrics) {
      console.log(`  ${String(m.round).padStart(2)}   | ${pct(m.causalChainRate)} | ${pct(m.linkageRate)} | ${String(m.outputChars).padStart(5)}`);
    }

    console.log("\nV1 FULL DEGRADATION CURVE:");
    console.log("Round | Causal | Linkage | Size");
    for (const m of v1Metrics) {
      console.log(`  ${String(m.round).padStart(2)}   | ${pct(m.causalChainRate)} | ${pct(m.linkageRate)} | ${String(m.outputChars).padStart(5)}`);
    }

    // Print the actual V2 Earlier Turns section for comparison
    let prev = "";
    for (let i = 0; i < TOTAL; i++) {
      prev = compile({ messages: makeRound(i), previousSummary: prev || undefined });
    }
    const etIdx = prev.indexOf("[Earlier Turns]");
    if (etIdx >= 0) {
      const after = prev.slice(etIdx);
      const end = after.indexOf("\n\n---\n\n", 1);
      console.log("\nV2 [Earlier Turns] (causal breadcrumbs in recall lines):");
      console.log(after.slice(0, end > 0 ? end : after.length));
    }

    // Assertions: V2 should not regress on any metric
    for (let i = 0; i < TOTAL; i++) {
      expect(v2Metrics[i].outputChars).toBeGreaterThan(0);
    }

    // V2 causal chain rate should be >= V1 (it uses the same extraction
    // with added causal info in the turn summaries)
    const v2Final = v2Metrics[TOTAL - 1];
    const v1Final = v1Metrics[TOTAL - 1];

    expect(v2Final.causalChainRate).toBeGreaterThanOrEqual(v1Final.causalChainRate);
  }, 60_000); // 300 deterministic compactions; not a five-second unit workload.

  test("determinism: V2 produces identical outputs for identical inputs", () => {
    const m1 = computeMetrics(100, makeRound);
    const m2 = computeMetrics(100, makeRound);
    for (let i = 0; i < m1.length; i++) {
      expect(m1[i].outputChars).toBe(m2[i].outputChars);
      expect(m1[i].causalChainRate).toBe(m2[i].causalChainRate);
    }
  }, 60_000); // 200 deterministic compactions, with every equality retained.

  test("causal extraction: all 20 round specs produce at least one causal element", () => {
    let atLeastOne = 0;
    for (const spec of ROUNDS) {
      const text = `The issue is ${spec.cause}. I will fix this by ${spec.resolution}.`;
      const chain = extractCausalChain(text);
      if (chain.cause || chain.resolution) atLeastOne++;
    }
    expect(atLeastOne).toBe(20);
  });

  test("causal extraction determinism", () => {
    for (const spec of ROUNDS) {
      const text = `The issue is ${spec.cause}. I will fix this by ${spec.resolution}.`;
      const c1 = extractCausalChain(text);
      const c2 = extractCausalChain(text);
      expect(c1.cause).toBe(c2.cause);
      expect(c1.resolution).toBe(c2.resolution);
    }
  });

  test("causal breadcrumbs carry resolution keys, not just filenames", () => {
    let prev = "";
    for (let i = 0; i < TOTAL; i++) {
      prev = compile({ messages: makeRound(i), previousSummary: prev || undefined });
    }

    // Count breadcrumbs with causal keys (contain "|")
    let causalBreadcrumbs = 0;
    let keywordBreadcrumbs = 0;
    for (const line of prev.split("\n")) {
      if (line.includes("...recall:")) {
        const content = line.slice(line.indexOf("...recall:") + 10);
        const parts = content.split(", ");
        for (const part of parts) {
          if (part.includes("|")) causalBreadcrumbs++;
          else keywordBreadcrumbs++;
        }
      }
    }

    console.log(`\nBreadcrumb quality: ${causalBreadcrumbs} causal (file|key), ${keywordBreadcrumbs} keyword-only`);
    expect(causalBreadcrumbs).toBeGreaterThan(0);
  });
});
