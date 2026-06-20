/**
 * リクエスト前のトークン見積もり（厳格ブロック用）。
 *
 * 厳格ブロックでは「最悪ケース」で見積もる:
 *  - 入力: メッセージ全体のトークン数（Claude 系は実トークナイザ、その他はヒューリスティック）
 *  - 出力: リクエストの max_tokens（未指定時は DEFAULT_MAX_TOKENS）
 * いずれも安全側に倒すため、入力には SAFETY_MARGIN を掛ける。
 */
import { countTokens } from "@anthropic-ai/tokenizer";
import type { ChatCompletionRequest } from "./types.js";
import { computeCostUsd } from "./pricing.js";

/** max_tokens 未指定時に最悪出力として仮定する上限 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 入力見積もりに掛ける安全マージン（過小評価でのすり抜け防止） */
const SAFETY_MARGIN = 1.15;

/** メッセージのロール等のオーバーヘッド分を 1 メッセージあたり加算 */
const PER_MESSAGE_OVERHEAD = 4;

function estimateOneMessageTokens(model: string, text: string): number {
  // Claude（anthropic）系は実トークナイザで精度高く計測
  if (model.includes("claude") || model.includes("anthropic")) {
    try {
      return countTokens(text);
    } catch {
      // フォールバックへ
    }
  }
  // 汎用ヒューリスティック: 概ね 4 文字 = 1 トークン
  return Math.ceil(text.length / 4);
}

/** 入力トークン見積もり（安全マージン込み） */
export function estimateInputTokens(req: ChatCompletionRequest): number {
  let total = 0;
  for (const m of req.messages) {
    total += estimateOneMessageTokens(req.model, m.content ?? "");
    total += PER_MESSAGE_OVERHEAD;
  }
  return Math.ceil(total * SAFETY_MARGIN);
}

/** 最悪出力トークン数（= max_tokens or 既定上限） */
export function worstCaseOutputTokens(req: ChatCompletionRequest): number {
  return req.max_tokens && req.max_tokens > 0 ? req.max_tokens : DEFAULT_MAX_TOKENS;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

/** リクエストの最悪ケースコスト見積もり */
export function estimateCost(req: ChatCompletionRequest): CostEstimate {
  const inputTokens = estimateInputTokens(req);
  const outputTokens = worstCaseOutputTokens(req);
  const estimatedUsd = computeCostUsd(req.model, inputTokens, outputTokens);
  return { inputTokens, outputTokens, estimatedUsd };
}
