/**
 * Bedrock Converse / ConverseStream の出力 → OpenAI ChatCompletion 形式へ変換。
 *
 * AWS SDK 型に依存しないよう、必要なフィールドだけを構造的に受け取る。
 */
import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  TokenUsage,
} from "./types.js";

/** Bedrock の stopReason → OpenAI finish_reason */
export function mapStopReason(stopReason?: string): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
      return "content_filter";
    default:
      return stopReason ? "stop" : null;
  }
}

/** Converse（非ストリーム）出力の最小構造 */
export interface BedrockConverseOutputLike {
  output?: { message?: { content?: Array<{ text?: string }> } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export function extractUsage(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): TokenUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

/** 非ストリーム: Converse 出力を OpenAI レスポンスへ */
export function toOpenAiResponse(
  out: BedrockConverseOutputLike,
  opts: { id: string; model: string; created: number },
): ChatCompletionResponse {
  const text =
    out.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
  const usage = extractUsage(out.usage);
  return {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapStopReason(out.stopReason),
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

/** ConverseStream イベントの最小構造（SDK の ConverseStreamOutput と互換） */
export interface BedrockStreamEventLike {
  messageStart?: { role?: string };
  contentBlockDelta?: { delta?: { text?: string } };
  messageStop?: { stopReason?: string };
  metadata?: { usage?: { inputTokens?: number; outputTokens?: number } };
}

function baseChunk(opts: {
  id: string;
  model: string;
  created: number;
}): Omit<ChatCompletionChunk, "choices"> {
  return {
    id: opts.id,
    object: "chat.completion.chunk",
    created: opts.created,
    model: opts.model,
  };
}

/**
 * ストリームイベントを OpenAI チャンクへ変換。
 * usage は別途 extractUsage で取得するためここでは扱わない（null を返す）。
 */
export function toOpenAiChunk(
  event: BedrockStreamEventLike,
  opts: { id: string; model: string; created: number },
): ChatCompletionChunk | null {
  if (event.messageStart) {
    return {
      ...baseChunk(opts),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };
  }
  if (event.contentBlockDelta?.delta?.text != null) {
    return {
      ...baseChunk(opts),
      choices: [
        {
          index: 0,
          delta: { content: event.contentBlockDelta.delta.text },
          finish_reason: null,
        },
      ],
    };
  }
  if (event.messageStop) {
    return {
      ...baseChunk(opts),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: mapStopReason(event.messageStop.stopReason),
        },
      ],
    };
  }
  return null;
}

/** stream_options.include_usage 相当の最終 usage チャンク */
export function usageChunk(
  usage: TokenUsage,
  opts: { id: string; model: string; created: number },
): ChatCompletionChunk {
  return {
    ...baseChunk(opts),
    choices: [],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}
