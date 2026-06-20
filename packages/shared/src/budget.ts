/**
 * 月次・チーム全体のコスト予算管理（DynamoDB usage テーブル）。
 *
 * テーブル構造:
 *   PK = teamId
 *   SK = "CONFIG"            -> { monthlyBudgetUsd }
 *   SK = "USAGE#<YYYY-MM>"   -> { accumulatedUsd, inputTokens, outputTokens, requestCount, updatedAt }
 *
 * - 予算チェックは GetItem 2 件（CONFIG + 当月 USAGE）。
 * - 記録は UpdateItem の ADD（atomic increment）で並行安全に加算。
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { computeCostUsd } from "./pricing.js";
import type { TokenUsage } from "./types.js";

export const CONFIG_SK = "CONFIG";

/** UTC 基準の当月キー "YYYY-MM" */
export function currentPeriod(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function usageSk(period: string): string {
  return `USAGE#${period}`;
}

export interface BudgetState {
  monthlyBudgetUsd: number;
  accumulatedUsd: number;
  period: string;
}

export interface BudgetCheckResult {
  ok: boolean;
  monthlyBudgetUsd: number;
  accumulatedUsd: number;
  estimatedUsd: number;
  /** チェック後に残るであろう予算（負なら超過） */
  remainingUsd: number;
}

export interface BudgetDeps {
  doc: DynamoDBDocumentClient;
  tableName: string;
  /** CONFIG が無い場合に使うデフォルト月次予算（USD） */
  defaultMonthlyBudgetUsd: number;
}

async function readNumber(
  deps: BudgetDeps,
  teamId: string,
  sk: string,
  attr: string,
): Promise<number | undefined> {
  const res = await deps.doc.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { teamId, sk },
      ProjectionExpression: "#a",
      ExpressionAttributeNames: { "#a": attr },
      ConsistentRead: true,
    }),
  );
  const v = res.Item?.[attr];
  return typeof v === "number" ? v : undefined;
}

/** 現在の予算状況を取得 */
export async function getBudgetState(
  deps: BudgetDeps,
  teamId: string,
  period: string = currentPeriod(),
): Promise<BudgetState> {
  const [budget, accumulated] = await Promise.all([
    readNumber(deps, teamId, CONFIG_SK, "monthlyBudgetUsd"),
    readNumber(deps, teamId, usageSk(period), "accumulatedUsd"),
  ]);
  return {
    monthlyBudgetUsd: budget ?? deps.defaultMonthlyBudgetUsd,
    accumulatedUsd: accumulated ?? 0,
    period,
  };
}

/**
 * 事前見積もりに基づく厳格ブロック判定。
 * accumulated + estimated > budget なら ok=false。
 */
export async function checkBudget(
  deps: BudgetDeps,
  teamId: string,
  estimatedUsd: number,
  period: string = currentPeriod(),
): Promise<BudgetCheckResult> {
  const state = await getBudgetState(deps, teamId, period);
  const projected = state.accumulatedUsd + estimatedUsd;
  return {
    ok: projected <= state.monthlyBudgetUsd,
    monthlyBudgetUsd: state.monthlyBudgetUsd,
    accumulatedUsd: state.accumulatedUsd,
    estimatedUsd,
    remainingUsd: state.monthlyBudgetUsd - projected,
  };
}

/**
 * 実トークン使用量から実コストを計算し、当月 USAGE に atomic ADD で加算。
 * 戻り値は加算後の accumulatedUsd。
 */
export async function recordUsage(
  deps: BudgetDeps,
  teamId: string,
  model: string,
  usage: TokenUsage,
  period: string = currentPeriod(),
  now: Date = new Date(),
): Promise<number> {
  const costUsd = computeCostUsd(model, usage.inputTokens, usage.outputTokens);
  const res = await deps.doc.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: { teamId, sk: usageSk(period) },
      UpdateExpression:
        "ADD accumulatedUsd :c, inputTokens :it, outputTokens :ot, requestCount :one SET updatedAt = :ts",
      ExpressionAttributeValues: {
        ":c": costUsd,
        ":it": usage.inputTokens,
        ":ot": usage.outputTokens,
        ":one": 1,
        ":ts": now.toISOString(),
      },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  const updated = res.Attributes?.accumulatedUsd;
  return typeof updated === "number" ? updated : 0;
}
