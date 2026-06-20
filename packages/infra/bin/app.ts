#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BedrockGatewayStack } from "../lib/bedrock-gateway-stack";

const app = new cdk.App();

new BedrockGatewayStack(app, "BedrockGatewayStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // 既定の月次予算（USD）。CONFIG アイテム未設定のチームに適用される。
  defaultMonthlyBudgetUsd: Number(process.env.DEFAULT_MONTHLY_BUDGET_USD ?? "100"),
});

app.synth();
