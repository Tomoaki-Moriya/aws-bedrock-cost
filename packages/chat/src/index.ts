/**
 * Chat Lambda — OpenAI 互換 POST /v1/chat/completions。
 * Lambda Response Streaming (streamifyResponse) で SSE 配信する。
 *
 * フロー:
 *  1. Authorizer context から teamId を取得
 *  2. body をパース → 入力見積もり + 最悪出力(max_tokens) でコスト見積もり
 *  3. 月次予算を厳格チェック（超過なら 402 で拒否）
 *  4. Bedrock Converse / ConverseStream 実行
 *  5. ストリーム時は OpenAI SSE チャンクへ変換して逐次 write
 *  6. 実 usage を DynamoDB に atomic ADD で記録
 */
import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  estimateCost,
  checkBudget,
  recordUsage,
  toBedrockConverseInput,
  toOpenAiResponse,
  toOpenAiChunk,
  usageChunk,
  extractUsage,
  openAiError,
  type ChatCompletionRequest,
  type BudgetDeps,
  type TokenUsage,
} from "@bedrock-gw/shared";
import type { APIGatewayProxyEvent } from "aws-lambda";

const bedrock = new BedrockRuntimeClient({});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const deps: BudgetDeps = {
  doc,
  tableName: process.env.USAGE_TABLE!,
  defaultMonthlyBudgetUsd: Number(process.env.DEFAULT_MONTHLY_BUDGET_USD ?? "100"),
};

function writeJson(
  responseStream: awslambda.ResponseStream,
  statusCode: number,
  body: unknown,
): void {
  const s = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { "content-type": "application/json" },
  });
  s.write(JSON.stringify(body));
  s.end();
}

function getTeamId(event: APIGatewayProxyEvent): string | undefined {
  const ctx = event.requestContext?.authorizer as
    | Record<string, string>
    | undefined;
  return ctx?.teamId;
}

function parseBody(event: APIGatewayProxyEvent): ChatCompletionRequest {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  return JSON.parse(raw) as ChatCompletionRequest;
}

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEvent, responseStream): Promise<void> => {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // --- 1. 認証コンテキスト ---
    const teamId = getTeamId(event);
    if (!teamId) {
      writeJson(
        responseStream,
        401,
        openAiError("unauthorized", "Missing team context", "authentication_error"),
      );
      return;
    }

    // --- 2. リクエストのパース・バリデーション ---
    let req: ChatCompletionRequest;
    try {
      req = parseBody(event);
    } catch {
      writeJson(responseStream, 400, openAiError("invalid_json", "Invalid JSON body"));
      return;
    }
    if (!req.model || !Array.isArray(req.messages) || req.messages.length === 0) {
      writeJson(
        responseStream,
        400,
        openAiError("invalid_request", "`model` and non-empty `messages` are required"),
      );
      return;
    }

    // --- 3. 見積もり + 予算厳格チェック ---
    const est = estimateCost(req);
    const gate = await checkBudget(deps, teamId, est.estimatedUsd);
    if (!gate.ok) {
      writeJson(
        responseStream,
        402,
        openAiError(
          "budget_exceeded",
          `Monthly budget exceeded for team. budget=$${gate.monthlyBudgetUsd.toFixed(
            4,
          )}, used=$${gate.accumulatedUsd.toFixed(4)}, estimated=$${est.estimatedUsd.toFixed(
            4,
          )}`,
          "insufficient_quota",
        ),
      );
      return;
    }

    const converseInput = toBedrockConverseInput(req);

    // --- 4/5. 実行 + 変換 ---
    try {
      if (req.stream) {
        await handleStream(responseStream, req, converseInput, teamId, {
          id,
          model: req.model,
          created,
        });
      } else {
        await handleBuffered(responseStream, req, converseInput, teamId, {
          id,
          model: req.model,
          created,
        });
      }
    } catch (err) {
      console.error("bedrock invocation failed", err);
      // ストリーム開始前ならここに到達（開始後は handleStream 内で処理）
      writeJson(
        responseStream,
        502,
        openAiError("upstream_error", "Bedrock invocation failed", "api_error"),
      );
    }
  },
);

async function handleBuffered(
  responseStream: awslambda.ResponseStream,
  req: ChatCompletionRequest,
  converseInput: ReturnType<typeof toBedrockConverseInput>,
  teamId: string,
  meta: { id: string; model: string; created: number },
): Promise<void> {
  const out = await bedrock.send(new ConverseCommand(converseInput));
  const usage = extractUsage(out.usage);
  await recordUsage(deps, teamId, req.model, usage);
  writeJson(responseStream, 200, toOpenAiResponse(out, meta));
}

async function handleStream(
  responseStream: awslambda.ResponseStream,
  req: ChatCompletionRequest,
  converseInput: ReturnType<typeof toBedrockConverseInput>,
  teamId: string,
  meta: { id: string; model: string; created: number },
): Promise<void> {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });

  const write = (chunk: unknown) => stream.write(`data: ${JSON.stringify(chunk)}\n\n`);

  let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    const resp = await bedrock.send(new ConverseStreamCommand(converseInput));
    if (resp.stream) {
      for await (const event of resp.stream) {
        if (event.metadata?.usage) {
          finalUsage = extractUsage(event.metadata.usage);
        }
        const chunk = toOpenAiChunk(event, meta);
        if (chunk) write(chunk);
      }
    }
    // include_usage 相当の最終 usage チャンク
    write(usageChunk(finalUsage, meta));
    stream.write("data: [DONE]\n\n");
  } catch (err) {
    console.error("stream failed mid-flight", err);
    // 既にヘッダ送信済みのため SSE エラーイベントで通知
    write(openAiError("upstream_error", "Bedrock stream failed", "api_error"));
    stream.write("data: [DONE]\n\n");
  } finally {
    stream.end();
    // 実 usage を記録（取得できた範囲で）
    await recordUsage(deps, teamId, req.model, finalUsage).catch((e) =>
      console.error("recordUsage failed", e),
    );
  }
}
