import type { ProviderUsage } from "@theaihatch/providers";

export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  version: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 1.25, version: "2026-01" },
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6, cachedInputPerMillionUsd: 0.075, version: "2026-01" }
};

export function estimateCost(model: string, usage: ProviderUsage): { costUsd: number | null; priceVersion: string } {
  const price = MODEL_PRICES[model];
  if (price === undefined) return { costUsd: null, priceVersion: "unknown" };
  const costUsd = (usage.inputTokens * price.inputPerMillionUsd + usage.outputTokens * price.outputPerMillionUsd + usage.cachedTokens * price.cachedInputPerMillionUsd) / 1_000_000;
  return { costUsd, priceVersion: price.version };
}
