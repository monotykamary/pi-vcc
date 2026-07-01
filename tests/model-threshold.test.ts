import { describe, test, expect } from "bun:test";
import { getModelThreshold, resolveReserveTokens, resolveTriggerTokens, type PiVccSettings, type ModelThreshold } from "../src/core/settings";

const t = (reserveTokens: number, keepRecentTokens?: number): ModelThreshold => ({
  reserveTokens,
  ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
});

describe("getModelThreshold", () => {
  test("returns undefined when no modelThresholds and no defaultThreshold", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
    };
    expect(getModelThreshold(settings, { id: "GLM-5.1", provider: "neuralwatt" })).toBeUndefined();
  });

  test("returns undefined when model is undefined and no defaultThreshold", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: { "neuralwatt/GLM-5.1": t(32768) },
    };
    expect(getModelThreshold(settings, undefined)).toBeUndefined();
  });

  test("returns defaultThreshold when model doesn't match any key", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: { "neuralwatt/GLM-5.1": t(32768) },
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "other-model", provider: "other" })).toEqual(t(8192));
  });

  test("returns defaultThreshold when model is undefined", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, undefined)).toEqual(t(8192));
  });

  test("matches on provider/modelId key", () => {
    const threshold = t(32768, 40000);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/zai-org/GLM-5.1-FP8": threshold,
      },
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "zai-org/GLM-5.1-FP8", provider: "neuralwatt" })).toEqual(threshold);
  });

  test("matches on modelId-only key when provider/modelId not found", () => {
    const threshold = t(16384);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "zai-org/GLM-5.1-FP8": threshold,
      },
      defaultThreshold: t(8192),
    };
    // provider/modelId doesn't match, but modelId does
    expect(getModelThreshold(settings, { id: "zai-org/GLM-5.1-FP8", provider: "other-provider" })).toEqual(threshold);
  });

  test("provider/modelId takes precedence over modelId-only key", () => {
    const providerThreshold = t(32768);
    const modelIdThreshold = t(16384);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": providerThreshold,
        "GLM-5.1": modelIdThreshold,
      },
    };
    expect(getModelThreshold(settings, { id: "GLM-5.1", provider: "neuralwatt" })).toEqual(providerThreshold);
  });

  test("falls through to modelId-only when provider is absent", () => {
    const threshold = t(16384);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "GLM-5.1": threshold,
      },
    };
    expect(getModelThreshold(settings, { id: "GLM-5.1" })).toEqual(threshold);
  });

  test("falls through to defaultThreshold when neither key matches", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": t(32768),
      },
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "Kimi-K2.6", provider: "neuralwatt" })).toEqual(t(8192));
  });

  test("returns globalThreshold when model doesn't match any key", () => {
    const threshold: ModelThreshold = { compactPercent: 65 };
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: { "neuralwatt/GLM-5.1": t(32768) },
      globalThreshold: threshold,
    };
    expect(getModelThreshold(settings, { id: "other-model", provider: "other" })).toEqual(threshold);
  });

  test("globalThreshold takes precedence over defaultThreshold", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      globalThreshold: t(65536),
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "unknown", provider: "other" })).toEqual(t(65536));
  });

  test("returns globalThreshold when model is undefined", () => {
    const threshold: ModelThreshold = { compactPercent: 70 };
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      globalThreshold: threshold,
    };
    expect(getModelThreshold(settings, undefined)).toEqual(threshold);
  });

  test("falls back to defaultThreshold when globalThreshold is not set", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "unknown", provider: "other" })).toEqual(t(8192));
  });

  test("works with multiple modelThresholds entries", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/zai-org/GLM-5.1-FP8": t(32768),
        "neuralwatt/moonshotai/Kimi-K2.6": t(65536),
        "makora/deepseek-ai/DeepSeek-V4-Pro": t(32768),
      },
      defaultThreshold: t(16384),
    };

    expect(getModelThreshold(settings, { id: "zai-org/GLM-5.1-FP8", provider: "neuralwatt" })).toEqual(t(32768));
    expect(getModelThreshold(settings, { id: "moonshotai/Kimi-K2.6", provider: "neuralwatt" })).toEqual(t(65536));
    expect(getModelThreshold(settings, { id: "deepseek-ai/DeepSeek-V4-Pro", provider: "makora" })).toEqual(t(32768));
    expect(getModelThreshold(settings, { id: "unknown-model", provider: "other" })).toEqual(t(16384));
  });
});

describe("resolveTriggerTokens", () => {
  test("returns compactAtTokens as the absolute trigger point", () => {
    expect(resolveTriggerTokens({ compactAtTokens: 150000 }, 1000000)).toBe(150000);
  });

  test("resolves compactPercent to its trigger point", () => {
    expect(resolveTriggerTokens({ compactPercent: 65 }, 128000)).toBe(83200);
  });

  test("reserveTokens takes precedence over compactAtTokens", () => {
    expect(resolveTriggerTokens({ reserveTokens: 50000, compactAtTokens: 100000 }, 200000)).toBe(150000);
  });

  test("compactAtTokens takes precedence over compactPercent", () => {
    expect(resolveTriggerTokens({ compactAtTokens: 150000, compactPercent: 65 }, 200000)).toBe(150000);
  });

  test("returns undefined for invalid compactAtTokens", () => {
    expect(resolveTriggerTokens({ compactAtTokens: 0 }, 200000)).toBeUndefined();
    expect(resolveTriggerTokens({ compactAtTokens: -1 }, 200000)).toBeUndefined();
    expect(resolveTriggerTokens({ compactAtTokens: Number.POSITIVE_INFINITY }, 200000)).toBeUndefined();
  });

  test("returns undefined when contextWindow is 0", () => {
    expect(resolveTriggerTokens({ compactAtTokens: 150000 }, 0)).toBeUndefined();
  });
});

describe("resolveReserveTokens", () => {
  test("returns reserveTokens when set", () => {
    expect(resolveReserveTokens({ reserveTokens: 32768 }, 128000)).toBe(32768);
  });

  test("returns undefined when neither reserveTokens nor compactPercent is set", () => {
    expect(resolveReserveTokens({}, 128000)).toBeUndefined();
  });

  test("returns undefined when only keepRecentTokens is set", () => {
    expect(resolveReserveTokens({ keepRecentTokens: 20000 }, 128000)).toBeUndefined();
  });

  test("computes reserveTokens from compactPercent", () => {
    // compactPercent: 65 on 128k window → reserve = 128000 * (1 - 65/100) = 44800
    expect(resolveReserveTokens({ compactPercent: 65 }, 128000)).toBe(44800);
  });

  test("compactPercent: 50 → reserve is exactly half", () => {
    expect(resolveReserveTokens({ compactPercent: 50 }, 200000)).toBe(100000);
  });

  test("compactPercent: 80 → reserve is 20%", () => {
    expect(resolveReserveTokens({ compactPercent: 80 }, 200000)).toBe(40000);
  });

  test("reserveTokens takes precedence over compactPercent", () => {
    expect(resolveReserveTokens({ reserveTokens: 32768, compactPercent: 65 }, 128000)).toBe(32768);
  });

  test("returns undefined for compactPercent < 1", () => {
    expect(resolveReserveTokens({ compactPercent: 0 }, 128000)).toBeUndefined();
  });

  test("returns undefined for compactPercent > 99", () => {
    expect(resolveReserveTokens({ compactPercent: 100 }, 128000)).toBeUndefined();
  });

  test("returns undefined when contextWindow is 0", () => {
    expect(resolveReserveTokens({ compactPercent: 65 }, 0)).toBeUndefined();
  });

  test("reserveTokens still works when contextWindow is 0", () => {
       expect(resolveReserveTokens({ reserveTokens: 32768 }, 0)).toBe(32768);
  });

  test("compactPercent = 1 → reserve is 99% of contextWindow", () => {
    expect(resolveReserveTokens({ compactPercent: 1 }, 128000)).toBe(126720);
  });

  test("compactPercent = 99 → reserve is 1% of contextWindow", () => {
    expect(resolveReserveTokens({ compactPercent: 99 }, 128000)).toBe(1280);
  });
});
