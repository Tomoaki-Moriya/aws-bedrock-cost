# aws-bedrock-cost — Bedrock コストガードゲートウェイ

チームで安心して Amazon Bedrock を運用するための **OpenAI 互換 API ゲートウェイ**。
Bedrock の手前に API Gateway + Lambda をかませ、**Bearer トークン認証**と
**月次・チーム全体のコスト上限**を強制する。設定した予算に到達するとアクセスを止める。

## 特徴

- OpenAI 互換 `POST /v1/chat/completions`（`stream: true/false` 両対応）
- **真の SSE ストリーミング**（API Gateway REST API のレスポンスストリーミング + Lambda `streamifyResponse`）
- Bearer トークン認証（Lambda Authorizer、トークンは SHA-256 で突合）
- **事前見積もりによる厳格なコストブロック**（超過しそうなリクエストは 402 で拒否）
- 実トークン使用量を DynamoDB に atomic に記録（月次・チーム全体）

## アーキテクチャ

```
Client (OpenAI SDK / curl -N)
  │ Authorization: Bearer <token>
  ▼
API Gateway REST API ──(TOKEN Authorizer)──▶ Authorizer Lambda（Bearer 検証）
  │ POST /v1/chat/completions
  │ Integration: AWS_PROXY / ResponseTransferMode=STREAM
  ▼
Chat Lambda（streamifyResponse）
  ├ 見積もり → 月次予算チェック（超過は 402）
  ├ Bedrock Converse / ConverseStream
  ├ OpenAI SSE チャンクへ変換し逐次 write
  └ 実 usage を DynamoDB に ADD 記録
  ▼
Amazon Bedrock
```

## 技術スタック

- Node.js 24 / TypeScript
- AWS CDK（全インフラ）
- API Gateway REST API（Regional, レスポンスストリーミング）
- AWS Lambda（Authorizer + Chat）
- Amazon Bedrock（Converse / ConverseStream）
- Amazon DynamoDB（API キー / 使用量・予算）

## モノレポ構成

```
packages/
  shared/      共有ロジック（型・料金・見積・変換・予算）
  authorizer/  Lambda Authorizer
  chat/        Chat Lambda（OpenAI 互換 / streaming）
  infra/       CDK アプリ（全インフラ）
```

## セットアップ

```bash
# Node 24 を使用
nvm use            # or: which node -> /opt/homebrew/bin/node (v24)
npm install
npm run build      # tsc --build（shared を含む）
npm run typecheck
```

## デプロイ

```bash
# 初回のみ（アカウント/リージョンごと）
npx -w @bedrock-gw/infra cdk bootstrap

# デプロイ
DEFAULT_MONTHLY_BUDGET_USD=100 npm run deploy
```

出力の `ApiBaseUrl` が POST 先。OpenAI SDK の `baseURL` には末尾の `/chat/completions`
を除いた `https://<api-id>.execute-api.<region>.amazonaws.com/v1` を指定する。

## API キーの登録（Bearer トークン）

トークンは平文保存しない。SHA-256 ハッシュを `bedrock-gw-apikeys` に登録する。

```bash
TOKEN="sk-team-xxxxx"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
aws dynamodb put-item --table-name bedrock-gw-apikeys --item \
  "{\"tokenHash\":{\"S\":\"$HASH\"},\"teamId\":{\"S\":\"team-a\"},\"enabled\":{\"BOOL\":true},\"label\":{\"S\":\"alice\"}}"
```

## 月次予算の設定（任意・チーム単位）

未設定なら `DEFAULT_MONTHLY_BUDGET_USD` が適用される。チーム個別に上書きする場合:

```bash
aws dynamodb put-item --table-name bedrock-gw-usage --item \
  '{"teamId":{"S":"team-a"},"sk":{"S":"CONFIG"},"monthlyBudgetUsd":{"N":"50"}}'
```

## 動作確認

```bash
# ストリーミング（-N でバッファ無効化）
curl -N https://<api>/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"model":"anthropic.claude-3-5-haiku-20241022-v1:0","stream":true,
       "messages":[{"role":"user","content":"こんにちは"}]}'

# 非ストリーミング
curl https://<api>/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"model":"anthropic.claude-3-5-haiku-20241022-v1:0","stream":false,
       "messages":[{"role":"user","content":"こんにちは"}]}'
```

予算到達時は HTTP 402 `budget_exceeded` を返す。

## 注意点

- 料金表は `packages/shared/src/pricing.ts`。最新の Bedrock 料金で更新すること。
- 厳格ブロックは「最悪出力 = `max_tokens`」で見積もるため安全側に倒れる。
  実コストは実 usage で正確に積み上げ、次回判定に反映される。
