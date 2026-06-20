/**
 * Bedrock モデルの料金表とコスト計算。
 *
 * 単価は 1,000 トークンあたりの USD。Bedrock の公開料金（us-east-1 オンデマンド）を基準とする。
 * 料金は変動するため、運用時は最新の AWS 料金ページで確認・更新すること。
 * https://aws.amazon.com/bedrock/pricing/
 */

export interface ModelPrice {
  /** 入力 1,000 トークンあたり USD */
  inputPer1k: number;
  /** 出力 1,000 トークンあたり USD */
  outputPer1k: number;
}

/**
 * キーは OpenAI 互換リクエストの `model`（= Bedrock の modelId / inference profile id）。
 * クライアントは Bedrock の modelId をそのまま指定する想定。
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Claude 3.5 / 3.7 / 4 系（代表例。必要に応じて追加）
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { inputPer1k: 0.0008, outputPer1k: 0.004 },
  "anthropic.claude-3-haiku-20240307-v1:0": { inputPer1k: 0.00025, outputPer1k: 0.00125 },
  "anthropic.claude-3-sonnet-20240229-v1:0": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "anthropic.claude-3-opus-20240229-v1:0": { inputPer1k: 0.015, outputPer1k: 0.075 },
  // US クロスリージョン推論プロファイル例
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "us.anthropic.claude-3-5-haiku-20241022-v1:0": { inputPer1k: 0.0008, outputPer1k: 0.004 },
};

/** 料金表に存在しないモデルに適用する保守的なフォールバック単価（高め＝安全側） */
export const FALLBACK_PRICE: ModelPrice = { inputPer1k: 0.015, outputPer1k: 0.075 };

export function getModelPrice(model: string): ModelPrice {
  return MODEL_PRICING[model] ?? FALLBACK_PRICE;
}

export function isKnownModel(model: string): boolean {
  return model in MODEL_PRICING;
}

/** 入力・出力トークン数から USD コストを計算 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = getModelPrice(model);
  return (inputTokens / 1000) * p.inputPer1k + (outputTokens / 1000) * p.outputPer1k;
}
