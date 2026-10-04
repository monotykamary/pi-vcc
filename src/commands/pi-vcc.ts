import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLastCompactionStats, formatCompactionStats, PI_VCC_COMPACT_INSTRUCTION } from "../hooks/before-compact";
import { countPiVccCompactionsFromSession, ordinalSuffix } from "../core/compaction-count";

export const registerPiVccCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc", {
    description: "Compact conversation with pi-vcc structured summary",
    handler: async (_args, ctx) => {
      ctx.compact({
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        onComplete: () => {
          const stats = getLastCompactionStats();
          const count = countPiVccCompactionsFromSession(ctx.sessionManager);
          const compactionLabel = count > 0
            ? ` (${count}${ordinalSuffix(count)} compaction)`
            : "";
          if (stats) {
            ctx.ui.notify(formatCompactionStats(stats, compactionLabel), "info");
          } else {
            ctx.ui.notify(`Compacted with pi-vcc${compactionLabel}`, "info");
          }
        },
        onError: (err) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact", "warning");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });
};
