/**
 * Bearer トークン関連のユーティリティ。
 * トークンは平文で保存せず SHA-256 ハッシュで突合する。
 */
import { createHash } from "node:crypto";

/** "Bearer xxx" / "xxx" のどちらからでもトークン本体を取り出す */
export function extractBearerToken(authorizationHeader?: string): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match) return match[1].trim();
  // スキーム無しでも受け付ける
  return trimmed.length > 0 ? trimmed : null;
}

/** トークンの SHA-256 16 進ハッシュ（DynamoDB apikeys の PK） */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
