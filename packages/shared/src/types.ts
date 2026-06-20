/**
 * OpenAI 互換の型定義（/v1/chat/completions に必要な範囲のみ）と内部共通型。
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  /** OpenAI はマルチモーダル content も許すが、本ゲートウェイは文字列のみ対応 */
  content: string;
  name?: string;
}

/** OpenAI ChatCompletion リクエスト（サポートする範囲） */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 非ストリームのレスポンス */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string | null;
  }>;
  usage: ChatCompletionUsage;
}

/** ストリームの 1 チャンク（SSE data: の中身） */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
  usage?: ChatCompletionUsage;
}

/** OpenAI 形式のエラーボディ */
export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
    param: string | null;
  };
}

/** Authorizer が context に詰める認証情報 */
export interface AuthContext {
  teamId: string;
  apiKeyId: string;
}

/** 実トークン使用量（Bedrock usage 由来） */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function openAiError(
  code: string,
  message: string,
  type = "invalid_request_error",
): OpenAiErrorBody {
  return { error: { message, type, code, param: null } };
}
