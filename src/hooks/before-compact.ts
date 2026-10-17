import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compile, type CompileInput } from "../core/summarize";
import {
  CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION,
  CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION,
  clearCodexContextOverflowPending,
  isCodexContextOverflowError,
  isCodexContextOverflowPending,
  isCodexOutputLimitError,
} from "../core/codex-output-limit";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { triggerInvisibleContinue } from "../core/invisible-continue";
import { isProactiveTriggerActive } from "./proactive-threshold";
import { countPiVccCompactionsFromSession, ordinalSuffix } from "../core/compaction-count";
import type { PiVccCompactionDetails } from "../details";

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

interface CompactionStats {
  summarized: number;
  kept: number;
  keptTokensEst: number;
}

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let lastCompactWasCodexRecovery = false;
let lastCompactWasProactive = false;
let lastCompactHandledByVcc = false;
let lastCompactDeferredToFabric = false;
let hasNotifiedFabricDeferral = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

/**
 * Compute the entry-ID range for summarized messages.
 *
 * Uses entry IDs instead of numeric indices so that vcc_recall can correctly
 * resolve the range against the full session file (not just the active branch,
 * where numeric indices would be branch-relative and wrong).
 *
 * Returns [firstSummarizedEntryId, lastSummarizedEntryId] or undefined.
 */
const computeMessageRange = (
  branchEntries: any[],
  firstKeptEntryId: string,
): [string, string] | undefined => {
  if (!firstKeptEntryId) return undefined;

  // If compact-all sentinel, find the last message entry
  if (firstKeptEntryId === "") {
    let lastId: string | undefined;
    for (const e of branchEntries) {
      if (e.type === "message" && e.message && e.id) {
        lastId = e.id;
      }
    }
    return lastId ? [branchEntries.find((e: any) => e.type === "message" && e.message)?.id ?? "", lastId] as [string, string] : undefined;
  }

  // Find the first message entry (start of summarized range)
  const firstMsgId = branchEntries.find(
    (e: any) => e.type === "message" && e.message && e.id,
  )?.id;
  if (!firstMsgId) return undefined;

  // If first kept entry IS the first message, nothing was summarized
  if (firstMsgId === firstKeptEntryId) return undefined;

  return [firstMsgId, firstKeptEntryId];
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

const isHiddenEmptyCustomMessage = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    role?: unknown;
    content?: unknown;
    display?: unknown;
  };
  if (candidate.role !== "custom" || candidate.display !== false) return false;
  return candidate.content === "" || (
    Array.isArray(candidate.content) && candidate.content.length === 0
  );
};

type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

/**
 * Find a completed tool-call cycle boundary in the first half of the
 * live messages. Used when there's only a single user message and we
 * can't cut at a task boundary.
 *
 * Scans for completed assistant→toolResult cycles and returns the index
 * of the last toolResult in the cycle nearest the midpoint.
 */
const findMidCycleBoundary = (liveMessages: EntryWithMessage[]): number => {
  const cycles: number[] = []; // end indices (toolResult) of completed cycles
  let currentAssistantIdx = -1;
  const pendingCalls = new Set<string>();

  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i].message;
    if (msg.role === "user") continue;
    if (msg.role === "assistant") {
      currentAssistantIdx = i;
      pendingCalls.clear();
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "toolCall" && part.id) pendingCalls.add(part.id);
        }
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const callId = (msg as any).toolCallId as string | undefined;
      if (callId) pendingCalls.delete(callId);
      if (pendingCalls.size === 0 && currentAssistantIdx >= 0) {
        cycles.push(i);
        currentAssistantIdx = -1;
      }
    }
  }

  if (cycles.length === 0) return -1;

  // Pick the cycle nearest the midpoint of the first half
  const targetIdx = Math.floor(liveMessages.length / 2);
  let best = cycles[0];
  let bestDist = Math.abs(cycles[0] - targetIdx);
  for (let i = 1; i < cycles.length; i++) {
    const dist = Math.abs(cycles[i] - targetIdx);
    if (dist < bestDist) {
      best = cycles[i];
      bestDist = dist;
    }
  }
  return best;
};

/** Rough token estimate (chars/4) for a live message, consistent with the
 * kept-tokens estimate used elsewhere in this module. */
function estimateMessageTokens(message: { content: unknown }): number {
  const c = message.content;
  let chars = 0;
  if (typeof c === "string") {
    chars = c.length;
  } else if (Array.isArray(c)) {
    for (const part of c as any[]) {
      if (part.type === "image") chars += 4800;
      else if (part.text) chars += part.text.length;
      else if (part.type === "toolCall") {
        const args = part.arguments ?? part.input;
        chars += (part.name?.length ?? 0) + (typeof args === "string" ? args.length : JSON.stringify(args ?? "").length);
      } else if (part.type === "toolResult") {
        chars += typeof part.content === "string" ? part.content.length : JSON.stringify(part.content ?? "").length;
      } else if (part.type === "thinking") {
        chars += (part.thinking?.length ?? 0);
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Find a completed tool-cycle boundary within `suffix` such that the kept
 * tail (suffix[boundary+1 .. end]) fits within `budgetTokens`, keeping as
 * much recent context as possible. Returns the index of the first message to
 * KEEP, or -1 when the suffix can't be split to fit (single oversized cycle,
 * or no completed cycles). */
const findSuffixSplitPoint = (
  suffix: EntryWithMessage[],
  budgetTokens: number,
): number => {
  if (suffix.length <= 2) return -1;

  // Completed-cycle end-indices (toolResult closing a cycle). Same detection
  // as findMidCycleBoundary.
  const cycleEnds: number[] = [];
  let currentAssistantIdx = -1;
  const pendingCalls = new Set<string>();
  for (let i = 0; i < suffix.length; i++) {
    const msg = suffix[i].message;
    if (msg.role === "user") { currentAssistantIdx = -1; pendingCalls.clear(); continue; }
    if (msg.role === "assistant") {
      currentAssistantIdx = i;
      pendingCalls.clear();
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "toolCall" && part.id) pendingCalls.add(part.id);
        }
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const callId = (msg as any).toolCallId as string | undefined;
      if (callId) pendingCalls.delete(callId);
      if (pendingCalls.size === 0 && currentAssistantIdx >= 0) {
        cycleEnds.push(i);
        currentAssistantIdx = -1;
      }
    }
  }
  if (cycleEnds.length === 0) return -1;

  // tailTokens[i] = tokens of suffix[i .. end].
  const tailTokens: number[] = new Array(suffix.length + 1).fill(0);
  for (let i = suffix.length - 1; i >= 0; i--) {
    tailTokens[i] = tailTokens[i + 1] + estimateMessageTokens(suffix[i].message);
  }
  // Earliest cycle boundary whose kept tail fits — keeps the most recent
  // context while staying under budget. boundary+1 must be < length so the
  // kept tail is non-empty.
  for (const boundary of cycleEnds) {
    if (boundary + 1 < suffix.length && tailTokens[boundary + 1] <= budgetTokens) {
      return boundary + 1;
    }
  }
  return -1;
};

export function buildOwnCut(branchEntries: any[], options?: { maxKeptTokens?: number }): OwnCutResult {
  const maxKeptTokens = options?.maxKeptTokens ?? 0;
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (
        e.type === "message" &&
        e.message &&
        !isHiddenEmptyCustomMessage(e.message)
      ) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (
        e.type === "message" &&
        e.message &&
        !isHiddenEmptyCustomMessage(e.message)
      ) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  // Task-boundary-aware cut: find the last user message whose response cycle
  // is complete (no unmatched tool calls). If the turn is mid-flight, push the
  // cut back to the previous user message to keep the entire in-progress turn
  // in the tail.
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  // Check if the turn following the last user message is "in progress"
  // (has an unmatched toolCall — assistant started but didn't finish)
  if (cutIdx > 0) {
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (let i = cutIdx + 1; i < liveMessages.length; i++) {
      const msg = liveMessages[i].message;
      if (msg.role === "user") break; // next turn starts
      // toolResult messages carry toolCallId at the message level, not in content parts
      if (msg.role === "toolResult" && (msg as any).toolCallId) {
        toolResultIds.add((msg as any).toolCallId);
        continue;
      }
      const content = msg.content;
      if (typeof content === "string" || !Array.isArray(content)) continue;
      for (const part of content) {
        if (part.type === "toolCall" && part.id) toolCallIds.add(part.id);
        if (part.type === "toolResult" && part.toolCallId) toolResultIds.add(part.toolCallId);
      }
    }
    const hasUnmatchedToolCall = [...toolCallIds].some(id => !toolResultIds.has(id));
    if (hasUnmatchedToolCall) {
      // Push cut back to the previous user message
      for (let i = cutIdx - 1; i > 0; i--) {
        if (liveMessages[i].message.role === "user") {
          cutIdx = i;
          break;
        }
      }
    }
  }

  // Oversized-turn guard (opt-in via options.maxKeptTokens > 0). When the
  // kept suffix — the most recent turn from the last user message — exceeds
  // the budget, keeping it whole would re-overflow on the compaction retry.
  // Split the turn at a completed tool-cycle boundary so the oversized early
  // part (typically a giant tool result) is summarized and only recent cycles
  // that fit are kept. If a single cycle is itself oversized (or there are no
  // completed cycles to split at), fall back to compact-all — safe because
  // pi-vcc compiles summaries statically (no LLM call that could overflow).
  if (cutIdx > 0 && maxKeptTokens > 0) {
    const suffix = liveMessages.slice(cutIdx);
    let suffixTokens = 0;
    for (const e of suffix) suffixTokens += estimateMessageTokens(e.message);
    if (suffixTokens > maxKeptTokens) {
      const splitIdx = findSuffixSplitPoint(suffix, maxKeptTokens);
      if (splitIdx >= 0) {
        const globalIdx = cutIdx + splitIdx;
        return {
          ok: true,
          messages: liveMessages.slice(0, globalIdx).map((e) => e.message),
          firstKeptEntryId: liveMessages[globalIdx].entry.id,
          compactAll: false,
        };
      }
      return {
        ok: true,
        messages: liveMessages.map((e) => e.message),
        firstKeptEntryId: "",
        compactAll: true,
      };
    }
  }

  if (cutIdx <= 0) {
    // Single user prompt (or no user at all) with a long agentic chain.
    // Instead of compact-all (which destroys the tail), find a completed
    // tool-call cycle boundary in the first half and cut there. This
    // preserves the later part of the session while summarizing the earlier
    // tool-call cycles.
    const cycleEndIdx = findMidCycleBoundary(liveMessages);
    if (cycleEndIdx > 0 && cycleEndIdx < liveMessages.length - 1) {
      return {
        ok: true,
        messages: liveMessages.slice(0, cycleEndIdx + 1).map((e) => e.message),
        firstKeptEntryId: liveMessages[cycleEndIdx + 1].entry.id,
        compactAll: false,
      };
    }
    // No completed cycle boundary found — fall back to compact-all as last resort.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
  };
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

export const shouldResumeAfterCompaction = (
  lastMsg: unknown,
  allowCodexRecovery = false,
): boolean => {
  if (!lastMsg || typeof lastMsg !== "object") return false;
  const message = lastMsg as { role?: unknown; stopReason?: unknown };
  if (message.role !== "assistant") return false;
  if (message.stopReason === "stop" || message.stopReason === "aborted") return false;
  if (message.stopReason === "error") {
    return allowCodexRecovery && (
      isCodexOutputLimitError(lastMsg) ||
      isCodexContextOverflowError(lastMsg)
    );
  }
  return true;
};

export type CompactionCompletionMetadata = {
  reason?: "manual" | "threshold" | "overflow";
  willRetry?: boolean;
};

export function shouldTriggerResumeForCompaction(
  event: CompactionCompletionMetadata,
  sessionIsIdle: boolean,
  wasProactiveCompaction: boolean,
  wasCodexRecoveryCompaction: boolean,
): boolean {
  if (event.willRetry) return true;
  if (wasCodexRecoveryCompaction || wasProactiveCompaction) return true;
  if (event.reason === "manual" || event.reason === "overflow") return false;
  if (event.reason === "threshold") return !sessionIsIdle;

  // Pi before 0.79.10 did not expose compaction reason metadata. Be
  // conservative there: an idle session may be manual or pre-prompt.
  return !sessionIsIdle;
}

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("session_before_compact", (event, ctx) => {
    // pi-fabric may run before pi-vcc and mark the shared event after claiming it.
    if ((event as any)._fabricCompaction === true) return;

    const { preparation, branchEntries, customInstructions } = event;
    const settings = loadSettings();

    // Per-model threshold guard was previously applied here, cancelling
    // compaction when context was below the per-model threshold. This
    // blocked manual /compact from working because session_before_compact
    // carries no "reason" field — manual and auto compactions are
    // indistinguishable (both have customInstructions: undefined).
    //
    // The per-model threshold is now served entirely by the proactive
    // trigger (in proactive-threshold.ts), which fires on agent_end /
    // model_select when the per-model threshold is crossed. This correctly
    // compacts earlier than pi-core's global threshold without needing to
    // cancel any compaction here.
    //
    // If pi-core's global threshold fires before the per-model threshold
    // is crossed, the compaction proceeds — slightly premature from the
    // per-model threshold's perspective, but this is preferable to blocking
    // an explicit user action (/compact).
    const isPiVcc = customInstructions === PI_VCC_COMPACT_INSTRUCTION;
    const isCodexOutputLimitCompaction =
      customInstructions === CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION;
    const isCodexContextOverflowMarker =
      customInstructions === CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION;
    const lastBranchAssistant = [...(branchEntries as any[])]
      .reverse()
      .find((entry: any) => entry.type === "message" && entry.message?.role === "assistant")
      ?.message;
    const isCodexContextOverflowCompaction =
      isCodexContextOverflowMarker ||
      (settings.overrideDefaultCompaction &&
        isCodexContextOverflowPending() &&
        isCodexContextOverflowError(lastBranchAssistant));
    const isPiVccHandled =
      isPiVcc || isCodexOutputLimitCompaction || isCodexContextOverflowCompaction;

    // Explicit /pi-vcc takes precedence over the pi-fabric engine. For every
    // other compaction, retain pi-vcc's trigger/recovery bookkeeping but let
    // pi-fabric compile the summary.
    if (!isPiVcc && process.env.PI_FABRIC_COMPACTION_ENGINE === "fabric") {
      if (!isPiVccHandled && !settings.overrideDefaultCompaction) return;
      if (isCodexContextOverflowCompaction) clearCodexContextOverflowPending();

      lastCompactWasPiVcc = false;
      lastCompactWasCodexRecovery =
        isCodexOutputLimitCompaction || isCodexContextOverflowCompaction;
      lastCompactWasProactive = isProactiveTriggerActive();
      lastCompactHandledByVcc = true;
      lastCompactDeferredToFabric = true;

      if (settings.overrideDefaultCompaction && !hasNotifiedFabricDeferral) {
        hasNotifiedFabricDeferral = true;
        try {
          ctx?.ui?.notify?.(
            "pi-vcc: deferring compaction to pi-fabric engine (explicit /pi-vcc still uses pi-vcc)",
            "info",
          );
        } catch {}
      }
      return;
    }

    // Always handle explicit /pi-vcc and Codex recovery markers. Otherwise,
    // only handle when the user opted in via settings.
    if (!isPiVccHandled && !settings.overrideDefaultCompaction) return;
    if (isCodexContextOverflowCompaction) clearCodexContextOverflowPending();

    // Budget the kept tail so that summary + kept + system/tools + the model's
    // OUTPUT budget (maxTokens) all fit in the window. Without reserving
    // maxTokens, the compaction-retry request can be rejected upfront
    // (input + maxTokens > contextWindow) and re-overflow. Falls back to
    // pi-core's keepRecentTokens when the window is unknown.
    const contextWindow = (ctx as any)?.model?.contextWindow ?? 0;
    const maxTokens = (ctx as any)?.model?.maxTokens ?? 0;
    const keepRecentTokens = (preparation as any)?.settings?.keepRecentTokens ?? 20000;
    const overhead = contextWindow > 0 ? Math.min(32768, Math.floor(contextWindow * 0.2)) : 32768;
    const outputReserve = maxTokens > 0 ? maxTokens : Math.floor(contextWindow * 0.5);
    const maxKeptTokens = contextWindow > 0
      ? Math.max(2048, contextWindow - outputReserve - overhead)
      : keepRecentTokens;
    const ownCut = buildOwnCut(branchEntries as any[], { maxKeptTokens });
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = (lastComp as any)?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && (branchEntries as any[]).some((e: any) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      dbg(settings, {
        cancelled: true,
        reason: ownCut.reason,
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!(lastComp as any).firstKeptEntryId,
          foundInBranch: (lastComp as any).firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === (lastComp as any).firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = agentMessages;

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message" && e.message?.role !== "system")
      : [];
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: keptEntries.reduce((sum: number, e: any) => sum + estimateMessageTokens(e.message), 0),
    };

    const config = settings;

    // Compute entry-ID range for compaction-scoped recall
    const messageRange = computeMessageRange(
      branchEntries as any[],
      firstKeptEntryId,
    );

    const compileInput: CompileInput = {
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    };

    const summary = compile(compileInput);

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(config, {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      messageRange,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const sections = [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);
    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections,
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      messageRange,
      compressionRatio: preparation.tokensBefore > 0
        ? Math.round(preparation.tokensBefore / Math.max(1, agentMessages.length))
        : undefined,
      timestamp: new Date().toISOString(),
      tokensBefore: preparation.tokensBefore || undefined,
      keptCount: lastStats?.kept || undefined,
      keptTokensEst: lastStats?.keptTokensEst || undefined,
    };

    lastCompactWasPiVcc = isPiVcc;
    lastCompactWasCodexRecovery =
      isCodexOutputLimitCompaction || isCodexContextOverflowCompaction;
    lastCompactWasProactive = isProactiveTriggerActive();
    lastCompactHandledByVcc = true;
    lastCompactDeferredToFabric = false;

    // Signal to neuralwatt-mcr that pi-vcc is handling compaction
    // so it doesn't cancel the event. Without this flag, neuralwatt-mcr
    // returns { cancel: true } for MCR models and pi-vcc's summary is
    // discarded by the runner's short-circuit.
    (event as any)._piVccOverriding = true;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  pi.on("session_start", () => {
    hasNotifiedFabricDeferral = false;
  });

  // After compaction completes, check if the agent loop stalled and needs
  // an invisible continue to resume.  This handles threshold compaction
  // where willRetry=false — pi-core doesn't auto-retry, and the agent loop
  // exits because hasQueuedMessages() returns false.  If the last message in
  // the rebuilt context is an assistant mid-task (tool_use, length, or error
  // that isn't a clean end_turn), the agent was interrupted and should
  // continue.
  pi.on("session_compact", (event, ctx) => {
    // Act when pi-vcc compiled the summary or tracked a compaction delegated
    // to pi-fabric so proactive and Codex recovery continuation still works.
    if (!lastCompactHandledByVcc) return;
    const wasCodexRecoveryCompaction = lastCompactWasCodexRecovery;
    const wasProactiveCompaction = lastCompactWasProactive;
    const wasDeferredToFabric = lastCompactDeferredToFabric;
    lastCompactHandledByVcc = false;
    lastCompactWasCodexRecovery = false;
    lastCompactWasProactive = false;
    lastCompactDeferredToFabric = false;

    // Fire success toast for pi-vcc's /compact path only (delayed to let UI
    // settle). /pi-vcc has its own callback, and pi-fabric owns delegated UI.
    if (!lastCompactWasPiVcc && !wasDeferredToFabric) {
      const stats = lastStats;
      const count = countPiVccCompactionsFromSession(ctx?.sessionManager as any);
      const compactionLabel = count > 0
        ? ` (${count}${ordinalSuffix(count)} compaction)`
        : "";
      if (stats) {
        setTimeout(() => {
          try {
            ctx?.ui?.notify?.(
              `pi-vcc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).${compactionLabel}`,
              "info",
            );
          } catch {}
        }, 500);
      }
    }

    // Determine if the agent needs to continue after compaction.
    // After rebuildSessionContext, the agent's state.messages are updated.
    // Check the last message: if it's an assistant message that isn't a
    // clean stop, the agent was mid-task and needs to resume.
    //
    // We do NOT continue when:
    // - Last message is user/toolResult (agent can continue naturally)
    // - Last message is assistant with stopReason=stop (task finished)
    // - Last message is assistant with stopReason=aborted (user cancelled)
    // - Last message is assistant with stopReason=error, unless this was
    //   a pi-vcc Codex recovery compaction
    //
    // We DO continue when:
    // - Last message is assistant with stopReason=toolUse (mid-tool cycle)
    // - Last message is assistant with stopReason=length (hit max tokens)
    // - Last message is a known Codex recovery error from the pi-vcc
    //   recovery compaction
    // - Compact-all (firstKeptEntryId="") — context is just the summary,
    //   the agent needs to re-enter the loop to continue the task
    try {
      const entries = ctx.sessionManager.getEntries();
      // Walk backwards to find the last message entry
      let lastMsg: { role: string; stopReason?: string; content?: unknown } | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = (entries as any[])[i];
        if (e.type === "message" && e.message) {
          lastMsg = e.message;
          break;
        }
      }
      // A core-owned retry also gets a marker. Agent.continue() drains the
      // queued marker before checking the assistant-tail role, so no Agent
      // prototype fallback is needed.
      const completion = event as CompactionCompletionMetadata;
      const legacyActiveCompaction =
        completion.reason === undefined &&
        completion.willRetry === undefined &&
        !ctx.isIdle();
      if (
        !completion.willRetry &&
        !legacyActiveCompaction &&
        !shouldResumeAfterCompaction(lastMsg, wasCodexRecoveryCompaction)
      ) return;
      if (!shouldTriggerResumeForCompaction(
        completion,
        ctx.isIdle(),
        wasProactiveCompaction,
        wasCodexRecoveryCompaction,
      )) return;

      // Queue through Pi's native follow-up path so a concurrent user prompt
      // wins cleanly instead of racing a low-level Agent.prompt([]) call.
      triggerInvisibleContinue(pi);
    } catch {
      // Non-critical — if context inspection fails, don't block compaction
    }
  });
};
