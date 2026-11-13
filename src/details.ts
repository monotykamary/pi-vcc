export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  /** Entry IDs [firstSummarizedId, lastSummarizedId] that this compaction summarized */
  messageRange?: [string, string];
  /** Summarized-to-summary token ratio (rounded) */
  compressionRatio?: number;
  /** ISO-8601 timestamp of when this compaction ran */
  timestamp?: string;
  /** Token count before compaction */
  tokensBefore?: number;
  /** Number of messages kept in tail */
  keptCount?: number;
  /** Estimated token count of kept tail */
  keptTokensEst?: number;
  /** Estimated token count of the context after this compaction */
  postTokensEst?: number;
}
