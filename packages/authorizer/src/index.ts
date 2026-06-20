/**
 * Lambda Authorizer（TOKEN タイプ）。
 * Authorization: Bearer <token> を検証し、DynamoDB apikeys を突合して
 * Allow ポリシー + context{teamId, apiKeyId} を返す。
 *
 * 無効トークンは "Unauthorized" を throw → API Gateway が 401 を返す。
 * 無効化済みキーは Deny ポリシー → 403。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { extractBearerToken, hashToken } from "@bedrock-gw/shared";
import type {
  APIGatewayTokenAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from "aws-lambda";

const TABLE = process.env.APIKEYS_TABLE!;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface ApiKeyItem {
  tokenHash: string;
  teamId: string;
  enabled: boolean;
  label?: string;
}

function policy(
  principalId: string,
  effect: "Allow" | "Deny",
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context,
  };
}

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const token = extractBearerToken(event.authorizationToken);
  if (!token) {
    throw new Error("Unauthorized");
  }

  const tokenHash = hashToken(token);
  const res = await doc.send(
    new GetCommand({
      TableName: TABLE,
      Key: { tokenHash },
    }),
  );
  const item = res.Item as ApiKeyItem | undefined;

  if (!item) {
    // 未登録トークン → 401
    throw new Error("Unauthorized");
  }

  if (item.enabled === false) {
    // 無効化済み → 403（Deny）
    return policy(tokenHash, "Deny", event.methodArn);
  }

  return policy(tokenHash, "Allow", event.methodArn, {
    teamId: item.teamId,
    apiKeyId: tokenHash,
  });
};
