/**
 * OpenAI ChatCompletion リクエスト → Bedrock Converse / ConverseStream の入力へ変換。
 *
 * Bedrock Converse の形:
 *   { modelId, system: [{text}], messages: [{role, content:[{text}]}], inferenceConfig }
 * - system ロールは messages ではなく system フィールドへ分離する
 * - tool ロールは本ゲートウェイ未対応のため user として扱う
 * - 連続する同一ロールは Converse の制約に合わせてマージする
 */
import type { ChatCompletionRequest, ChatMessage } from "./types.js";

export interface BedrockConverseInput {
  modelId: string;
  system?: Array<{ text: string }>;
  messages: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

function mapRole(role: ChatMessage["role"]): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

function toStopSequences(stop?: string | string[]): string[] | undefined {
  if (!stop) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

export function toBedrockConverseInput(req: ChatCompletionRequest): BedrockConverseInput {
  const system: Array<{ text: string }> = [];
  const messages: BedrockConverseInput["messages"] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      if (m.content) system.push({ text: m.content });
      continue;
    }
    const role = mapRole(m.role);
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      // 連続同一ロールはマージ（Converse は交互ロールを要求するため）
      last.content.push({ text: m.content ?? "" });
    } else {
      messages.push({ role, content: [{ text: m.content ?? "" }] });
    }
  }

  const inferenceConfig: BedrockConverseInput["inferenceConfig"] = {};
  if (req.max_tokens != null) inferenceConfig.maxTokens = req.max_tokens;
  if (req.temperature != null) inferenceConfig.temperature = req.temperature;
  if (req.top_p != null) inferenceConfig.topP = req.top_p;
  const stopSequences = toStopSequences(req.stop);
  if (stopSequences) inferenceConfig.stopSequences = stopSequences;

  return {
    modelId: req.model,
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
  };
}
