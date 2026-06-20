import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";

export interface BedrockGatewayStackProps extends cdk.StackProps {
  /** CONFIG 未設定チームに適用する既定の月次予算（USD） */
  defaultMonthlyBudgetUsd: number;
}

const PACKAGES_ROOT = path.join(__dirname, "..", "..");

export class BedrockGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BedrockGatewayStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------
    // DynamoDB
    // ---------------------------------------------------------------
    // API キー（Bearer トークンの SHA-256 → teamId）
    const apiKeysTable = new dynamodb.Table(this, "ApiKeysTable", {
      tableName: "bedrock-gw-apikeys",
      partitionKey: { name: "tokenHash", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // 使用量・予算（teamId + sk）。CONFIG / USAGE#<YYYY-MM>
    const usageTable = new dynamodb.Table(this, "UsageTable", {
      tableName: "bedrock-gw-usage",
      partitionKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      // 古い月次レコードを任意で自動削除したい場合に使用（属性が無ければ無効）
      timeToLiveAttribute: "ttl",
    });

    // ---------------------------------------------------------------
    // Lambda Authorizer（Bearer 検証のみ）
    // ---------------------------------------------------------------
    const authorizerFn = new NodejsFunction(this, "AuthorizerFn", {
      functionName: "bedrock-gw-authorizer",
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(PACKAGES_ROOT, "authorizer", "src", "index.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        APIKEYS_TABLE: apiKeysTable.tableName,
      },
      bundling: {
        minify: true,
        target: "node22",
        sourceMap: true,
      },
    });
    apiKeysTable.grantReadData(authorizerFn);

    // ---------------------------------------------------------------
    // Chat Lambda（OpenAI 互換 / streaming）
    // ---------------------------------------------------------------
    const chatFn = new NodejsFunction(this, "ChatFn", {
      functionName: "bedrock-gw-chat",
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(PACKAGES_ROOT, "chat", "src", "index.ts"),
      handler: "handler",
      // ストリーミングは最大 15 分まで可。長文生成に備える
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        USAGE_TABLE: usageTable.tableName,
        DEFAULT_MONTHLY_BUDGET_USD: String(props.defaultMonthlyBudgetUsd),
      },
      bundling: {
        minify: true,
        target: "node22",
        sourceMap: true,
        // bedrock-runtime はランタイム同梱が保証されないためバンドルに含める
        // （externalModules を空にして @aws-sdk/* を同梱）
        externalModules: [],
        // tokenizer はアセットを持つため esbuild で潰さず npm 同梱する
        nodeModules: ["@anthropic-ai/tokenizer"],
      },
    });
    usageTable.grantReadWriteData(chatFn);
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // ---------------------------------------------------------------
    // API Gateway REST API（Regional）+ TOKEN Authorizer
    // ---------------------------------------------------------------
    const api = new apigw.RestApi(this, "Api", {
      restApiName: "bedrock-gw",
      description: "OpenAI 互換 Bedrock ゲートウェイ（Bearer 認証 + 月次コスト上限）",
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      deployOptions: { stageName: "v1" },
    });

    const authorizer = new apigw.TokenAuthorizer(this, "BearerAuthorizer", {
      handler: authorizerFn,
      identitySource: apigw.IdentitySource.header("Authorization"),
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    // /v1/chat/completions （ステージが /v1 のためパスは /chat/completions）
    const chat = api.root.addResource("chat").addResource("completions");
    const integration = new apigw.LambdaIntegration(chatFn, { proxy: true });
    const method = chat.addMethod("POST", integration, {
      authorizer,
      authorizationType: apigw.AuthorizationType.CUSTOM,
    });

    // --- レスポンスストリーミング有効化（L2 未対応のため CfnMethod を上書き）---
    const cfnMethod = method.node.defaultChild as apigw.CfnMethod;
    cfnMethod.addPropertyOverride("Integration.ResponseTransferMode", "STREAM");
    cfnMethod.addPropertyOverride(
      "Integration.Uri",
      `arn:aws:apigateway:${this.region}:lambda:path/2021-11-15/functions/${chatFn.functionArn}/response-streaming-invocations`,
    );

    // API Gateway が Chat Lambda を（ストリーミング呼び出しで）invoke できるよう許可
    chatFn.addPermission("ApiGwInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: this.formatArn({
        service: "execute-api",
        resource: api.restApiId,
        resourceName: "*/*/*",
      }),
    });

    // ---------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, "ApiBaseUrl", {
      value: `${api.url}chat/completions`,
      description: "POST 先（OpenAI baseURL は末尾の /chat/completions を除いた URL）",
    });
    new cdk.CfnOutput(this, "ApiKeysTableName", { value: apiKeysTable.tableName });
    new cdk.CfnOutput(this, "UsageTableName", { value: usageTable.tableName });
  }
}
