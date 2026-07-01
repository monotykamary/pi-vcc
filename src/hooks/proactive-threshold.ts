import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings, getModelThreshold, resolveTriggerTokens } from "../core/settings";

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

// Cooldown after compaction to prevent double-trigger.
// Set immediately when we call ctx.compact() AND on session_compact,
// cleared after 3 seconds.
let lastCompactTime = 0;
const COOLDOWN_MS = 3000;

// Flag: when true, session_before_compact should NOT cancel even if
// tokensBefore is below the per-model threshold. This is set when
// our proactive trigger calls ctx.compact() and cleared when
// session_compact fires. It prevents the threshold guard from
// cancelling a compaction that we ourselves initiated.
let proactiveTriggerActive = false;

const setCooldown = () => { lastCompactTime = Date.now(); };
const isCoolingDown = () => Date.now() - lastCompactTime < COOLDOWN_MS;

/** Check if a proactive trigger is currently in flight. */
export const isProactiveTriggerActive = () => proactiveTriggerActive;

/** Reset all proactive state (for testing / session start). */
export const resetProactiveState = () => {
  lastCompactTime = 0;
  proactiveTriggerActive = false;
};

/**
 * Check if a configured threshold has been crossed and trigger compaction
 * if so. Safe to call from multiple event handlers — cooldown prevents
 * double-triggering.
 */
const checkAndTrigger = (ctx: { model?: any; getContextUsage?: () => any; compact?: () => void; ui?: any }, source: string) => {
  const settings = loadSettings();
  const threshold = getModelThreshold(settings, ctx.model);

  // No threshold → nothing to do (pi-core's global threshold owns it)
  if (!threshold) return;

  const contextWindow = ctx.model?.contextWindow ?? 0;
  const effectiveThreshold = resolveTriggerTokens(threshold, contextWindow);
  if (effectiveThreshold == null) return;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  // This threshold's compaction trigger point.

  // Only trigger if context EXCEEDS the threshold.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(
      `pi-vcc: [${source}] Context at ${pct}% exceeds threshold (${formatTokens(effectiveThreshold)} tok). Compacting...`,
      "info",
    );
  } catch {}

  // Set cooldown IMMEDIATELY (before ctx.compact() runs) to prevent
  // pi-core's own _checkCompaction from also triggering compaction
  // on the same turn.
  setCooldown();

  // Mark that this compaction was triggered by us, so session_before_compact
  // doesn't cancel it if tokensBefore differs from getContextUsage().
  proactiveTriggerActive = true;

  ctx.compact?.();
};

/**
 * Registers proactive configured compaction thresholds.
 *
 * Three triggers:
 *
 * 1. `agent_end` — after each agent run completes, check if context
 *    exceeds the active configured threshold. If that threshold is lower
 *    than pi-core's global threshold (meaning this config wants to compact
 *    earlier), pi-core won't trigger compaction — so we do.
 *
 * 2. `model_select` — when switching models, the new model may have a
 *    different threshold. Check immediately in case current context exceeds
 *    the new threshold.
 *
 * 3. `session_compact` — cooldown tracking + clear proactiveTriggerActive.
 *    After any compaction completes, we set a cooldown to prevent
 *    double-triggering and clear the self-initiated flag.
 *
 * `session_before_compact` reads `isProactiveTriggerActive()` to decide
 * whether to cancel. When our proactive trigger fires, ctx.compact() is
 * queued but hasn't run yet. By the time session_before_compact actually
 * fires, tokensBefore may differ from the getContextUsage() snapshot
 * that triggered the compact. Without the flag, the threshold guard would
 * cancel the compaction we ourselves requested — producing confusing
 * "Compacting..." then "Skipped compaction" notifications.
 */
export const registerProactiveThresholdHook = (pi: ExtensionAPI) => {
  // Proactive compaction after each agent run
  pi.on("agent_end", (_event, ctx) => {
    checkAndTrigger(ctx, "auto");
  });

  // Proactive compaction on model switch
  pi.on("model_select", (_event, ctx) => {
    checkAndTrigger(ctx, "model-switch");
  });

  // Track compaction completion: set cooldown and clear self-initiated flag
  pi.on("session_compact", () => {
    setCooldown();
    proactiveTriggerActive = false;
  });

  // Reset state on session start so state doesn't leak between sessions
  pi.on("session_start", () => {
    lastCompactTime = 0;
    proactiveTriggerActive = false;
  });
};
