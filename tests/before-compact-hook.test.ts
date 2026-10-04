import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook, getLastCompactionStats, PI_VCC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact";
import {
  CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION,
  isCodexContextOverflowPending,
  markCodexContextOverflowPending,
} from "../src/core/codex-output-limit";
import { VCC_RESUME_CUSTOM_TYPE } from "../src/core/invisible-continue";

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH = "/tmp/pi-vcc-debug.json";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-test-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  delete process.env.PI_FABRIC_COMPACTION_ENGINE;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal ExtensionAPI stub: capture handlers and provide mocked UI/session APIs.
function createMockPi(opts: { projection?: unknown } = {}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getEntries: () => [],
      ...(opts.projection ? { buildSessionProjection: () => opts.projection } : {}),
    },
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
  const pi = {
    on: (eventName: string, handler: (event: any, context: any) => any) => {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
    sendMessage: (message: any, options: any) => {
      sentMessages.push({ message, options });
    },
  } as any;
  return {
    pi,
    invoke: (event: any) => handlers.get("session_before_compact")![0](event, ctx),
    emit: (eventName: string, event: any = {}, context: any = ctx) => {
      let result: any;
      for (const handler of handlers.get(eventName) ?? []) {
        const next = handler(event, context);
        if (next !== undefined) result = next;
      }
      return result;
    },
    notifyCalls,
    sentMessages,
  };
}

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

function makeEvent(branchEntries: any[], customInstructions?: string) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
    },
    signal: new AbortController().signal,
  };
}

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });

describe("registerBeforeCompactHook: cancel paths", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("/pi-vcc with too few live messages cancels and notifies warning", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Too few messages");
  });

  test("/pi-vcc with no user message compacts all instead of cancelling", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "assistant"), msg("m2", "assistant"), msg("m3", "assistant")];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // No longer cancels — compacts all to recover from context overflow
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
  });

  test("/compact with override=true cancels and notifies (NEW: was silent before)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, undefined))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
  });

  test("/compact with override=false short-circuits (no notify, returns undefined)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, undefined))).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });

  test("debug:true writes metrics-only snapshot on cancel with no content leakage", () => {
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    // Use too_few_live_messages cancel path to test content leakage
    const entries = [
      msg("m1", "user", "SECRET_TOKEN_abc123"),
      msg("m2", "assistant", "sensitive response"),
    ];
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });

    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.reason).toBe("too_few_live_messages");

    // No content leakage
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET_TOKEN_abc123");
    expect(serialized).not.toContain("sensitive response");
  });

  test("debug:false does NOT write snapshot", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(existsSync(DEBUG_PATH)).toBe(false);
  });
});

describe("registerBeforeCompactHook: pi-fabric interop", () => {
  beforeEach(() => {
    delete process.env.PI_FABRIC_COMPACTION_ENGINE;
  });
  afterEach(() => {
    delete process.env.PI_FABRIC_COMPACTION_ENGINE;
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  test("defers when pi-fabric already claimed the event", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const event = makeEvent([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "work"),
      msg("m3", "user", "continue"),
    ], PI_VCC_COMPACT_INSTRUCTION) as any;
    event._fabricCompaction = true;

    expect(invoke(event)).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });

  test("defers to the configured pi-fabric engine and notifies once per session", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    process.env.PI_FABRIC_COMPACTION_ENGINE = "fabric";
    const { pi, invoke, emit, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    emit("session_start");

    const event = makeEvent([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "work"),
      msg("m3", "user", "continue"),
    ]);
    expect(invoke(event)).toBeUndefined();
    expect(invoke(event)).toBeUndefined();
    expect(notifyCalls).toEqual([{
      msg: "pi-vcc: deferring compaction to pi-fabric engine (explicit /pi-vcc still uses pi-vcc)",
      level: "info",
    }]);

    emit("session_start");
    expect(invoke(event)).toBeUndefined();
    expect(notifyCalls).toHaveLength(2);
  });

  test("explicit /pi-vcc takes precedence over the pi-fabric engine", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    process.env.PI_FABRIC_COMPACTION_ENGINE = "fabric";
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const result = invoke(makeEvent([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "done"),
    ], PI_VCC_COMPACT_INSTRUCTION));

    expect(result.compaction).toBeDefined();
  });

  test("preserves Codex output-limit recovery continuation while deferring", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    process.env.PI_FABRIC_COMPACTION_ENGINE = "fabric";
    const { pi, invoke, emit, sentMessages } = createMockPi();
    registerBeforeCompactHook(pi);
    const codexError = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      stopReason: "error",
      errorMessage: "Model stopped because it reached the maximum output token limit.",
    };
    const entries = [
      msg("m1", "user", "go"),
      { id: "m2", type: "message", message: codexError },
    ];

    expect(invoke(makeEvent(entries, CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION))).toBeUndefined();
    emit("session_compact", { reason: "threshold", willRetry: false }, {
      isIdle: () => true,
      sessionManager: { getEntries: () => entries },
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.customType).toBe(VCC_RESUME_CUSTOM_TYPE);
    expect(sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("detects and clears pending Codex context overflow while deferring", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    process.env.PI_FABRIC_COMPACTION_ENGINE = "fabric";
    const { pi, invoke, emit, sentMessages } = createMockPi();
    registerBeforeCompactHook(pi);
    markCodexContextOverflowPending();
    const codexError = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      stopReason: "error",
      errorMessage: "Codex error: Your input exceeds the context window of this model.",
    };
    const entries = [
      msg("m1", "user", "go"),
      { id: "m2", type: "message", message: codexError },
    ];

    expect(invoke(makeEvent(entries))).toBeUndefined();
    expect(isCodexContextOverflowPending()).toBe(false);
    emit("session_compact", { reason: "overflow", willRetry: false }, {
      isIdle: () => true,
      sessionManager: { getEntries: () => entries },
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.customType).toBe(VCC_RESUME_CUSTOM_TYPE);
  });
});

describe("registerBeforeCompactHook: keptTokensEst", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  test("counts reasoning and tool-call arguments in the kept tail", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const thinking = "t".repeat(4_000);
    const command = "c".repeat(4_000);
    const entries: any[] = [
      msg("m1", "user", "go"),
      { id: "m2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "summarized" }] } },
      { id: "m3", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "r".repeat(400) }] } },
      msg("m4", "user", "keep this turn"),
      {
        id: "m5",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking },
            { type: "toolCall", id: "tc1", name: "bash", arguments: { command } },
          ],
        },
      },
      { id: "m6", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }] } },
    ];

    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("m4");

    // (4000 reasoning + 4000 arguments + name/result) / 4 > 1900. The old
    // inline reducer ignored reasoning and read arguments from `input`, so it
    // reported single-digit tokens here.
    expect(getLastCompactionStats()!.keptTokensEst).toBeGreaterThan(1900);
  });
});

describe("registerBeforeCompactHook: compact-all path", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("single-user + autonomous tail → cuts at mid-cycle boundary", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
    // Single user at idx 0, completed cycle m2→m3 ends at idx 2 (midpoint=2)
    // Cut after m3, keep from m4 onward
    expect(result.compaction.firstKeptEntryId).toBe("m4");
    expect(notifyCalls).toHaveLength(0); // no cancel notify on success
  });
});

describe("registerBeforeCompactHook: postTokensEst", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  const projection = {
    messages: [
      { role: "system", content: "", sections: { rules: "r".repeat(4_000) } },
      { role: "user", content: "o".repeat(1_600) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(4_000) }] },
    ],
  };

  const entries = () => [
    msg("m1", "user", "go"),
    { id: "m2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "summarized" }] } },
    { id: "m3", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "r" }] } },
    msg("m4", "user", "keep"),
    { id: "m5", type: "message", message: { role: "assistant", content: [{ type: "text", text: "tail" }] } },
  ];

  test("is calibrated against tokensBefore", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi({ projection });
    registerBeforeCompactHook(pi);

    const first = makeEvent(entries(), PI_VCC_COMPACT_INSTRUCTION);
    first.preparation.tokensBefore = 1_000;
    invoke(first);
    const a = getLastCompactionStats()!.postTokensEst!;

    const second = makeEvent(entries(), PI_VCC_COMPACT_INSTRUCTION);
    second.preparation.tokensBefore = 2_000;
    invoke(second);
    const b = getLastCompactionStats()!.postTokensEst!;

    expect(a).toBeGreaterThan(0);
    expect(Math.abs(b - 2 * a)).toBeLessThanOrEqual(1);
  });

  test("is omitted when the session manager cannot project", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi(); // no buildSessionProjection
    registerBeforeCompactHook(pi);
    invoke(makeEvent(entries(), PI_VCC_COMPACT_INSTRUCTION));
    expect(getLastCompactionStats()!.postTokensEst).toBeUndefined();
  });
});
