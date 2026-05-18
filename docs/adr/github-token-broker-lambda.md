# GitHub Token Broker Lambda 実装計画

## 背景

現在、AgentCore Runtime は起動時に実行ロール (`AgentCoreRuntime.Runtime.ExecutionRole`) の `secretsmanager:GetSecretValue` 権限を使って、Secrets Manager から GitHub / GitLab の Personal Access Token を取得し、環境変数および `gh auth login` / `glab auth login` に流し込んでいる。

実装箇所:
- `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts:440-464` — 実行ロールに `secretsmanager:GetSecretValue` を付与
- `packages/agent/scripts/startup.sh:10-65` — `aws secretsmanager get-secret-value` を直接コール

### リスク

Agent は `execute_command` tool で任意のシェルコマンドを実行できる。`packages/agent/src/runtime/tools/execute-command.ts:29-49,154-171` で以下の多層防御が入っているが、いずれも完全ではない:

1. IMDS IP (`169.254.169.254` など) の文字列ブラックリスト → 十進/十六進表記変換、DNS リバインディング、Node スクリプト経由で回避可能
2. 子プロセス env の `AWS_EC2_METADATA_DISABLED=true` / ECS credential relay の削除 → 親プロセスから credentials 抽出されれば無効

したがって、Runtime 実行ロールに `secretsmanager:GetSecretValue` が残っている限り、サンドボックス脱出時に設定された **全ての** 秘密（GitHub / GitLab token）が流出する経路が常時開いている。

## 目的

1. Runtime 実行ロールから `secretsmanager:GetSecretValue` を **完全に削除** する
2. GitHub token の取得経路を **専用 Lambda 1 つだけ** に集約し、経路の予測困難化と監査の単純化を実現する
3. GitLab 関連の仕組みは **全て削除** する（機能を GitHub に絞る）

### 非目標

- 取得後の token 保管 (`~/.config/gh/hosts.yml`) の保護 → 別途 (C) 案として将来検討
- GitHub App installation token 方式への移行 → 将来の拡張として本計画では扱わない
- IMDS 経由 credential 取得のブロック → AgentCore Runtime の機構に依存するため本計画の範囲外

## 設計

### 全体フロー

```
[AgentCore Runtime container]
    ↓ startup.sh が aws lambda invoke
[GitHub Token Broker Lambda]  ← SECRET_NAME 固定 / IAM は該当 secret のみ
    ↓ secretsmanager:GetSecretValue
[Secrets Manager: agentcore/{env}/github-token]
    ↑ token 返却
[startup.sh が payload の .token を gh auth login --with-token に流す]
```

### Lambda 仕様 (`packages/lambda-tools/github-token-broker`)

**位置**: 既存 Gateway Target Lambda 群 (`packages/lambda-tools/tools/*`) とは **別階層** に配置する。Gateway Target は Agent が MCP 経由で呼べてしまうため、この Lambda は Target 化しない。新規ディレクトリ `packages/lambda-tools/brokers/github-token-broker/` を推奨。

**責務**: 固定の 1 つの Secrets Manager secret を取得して返すだけ。

**ハンドラ入力**: `{}` のみ受理。入力に `SecretId` や他フィールドが含まれていても **無視する**（Confused Deputy 対策）。

**ハンドラ出力**:
```json
{ "token": "<secret string>" }
```

**環境変数**:
- `GITHUB_TOKEN_SECRET_NAME` — 取得対象の Secrets Manager secret 名（Lambda 作成時に固定、実行時の入力では上書き不可）

**IAM 実行ロール**:
- `secretsmanager:GetSecretValue` を `arn:aws:secretsmanager:{region}:{account}:secret:{GITHUB_TOKEN_SECRET_NAME}-*` のみに限定
- CloudWatch Logs 基本権限のみ

**Lambda Resource-based policy**:
- `lambda:InvokeFunction` を **AgentCore Runtime 実行ロール ARN** にのみ許可
- Principal 条件に `aws:SourceArn` で Runtime の ARN を追加（Cross-account 経路の封鎖）

**その他**:
- Runtime NodeJS 22.x、memory 128 MB、timeout 10s
- ログ出力は `SecretId` を含めるが `SecretString` 値は **絶対に出さない**
- 予期しない入力フィールドは警告ログを出して無視

### CDK 変更

#### `packages/cdk/lib/constructs/agentcore/github-token-broker.ts` (新設)

```
export interface GitHubTokenBrokerProps {
  readonly resourcePrefix: string;
  readonly githubTokenSecretName: string;
}

export class GitHubTokenBroker extends Construct {
  public readonly lambdaFunction: lambda.Function;
  public readonly functionArn: string;
  // grantInvoke(grantee: iam.IGrantable) で Runtime 実行ロールに lambda:InvokeFunction を付与
}
```

実装要点:
- `lambda.Function` (NodejsFunction) で `packages/lambda-tools/brokers/github-token-broker/src/handler.ts` をバンドル
- 環境変数 `GITHUB_TOKEN_SECRET_NAME` を Lambda 作成時に注入
- 実行ロールに secret ARN を `-*` 付きで付与
- Export: `grantInvoke(grantee)` メソッドで Runtime 側に `lambda:InvokeFunction` を付与できるようにする

#### `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts` の変更

1. `githubTokenSecretName` prop を **削除**、代わりに `githubTokenBrokerLambdaArn?: string` を追加
2. `SecretsManagerGitHubTokenAccess` の IAM statement を **削除**
3. 代わりに `lambda:InvokeFunction` を broker Lambda ARN のみに付与:
   ```ts
   if (props.githubTokenBrokerLambdaArn) {
     this.runtime.addToRolePolicy(
       new iam.PolicyStatement({
         sid: 'InvokeGitHubTokenBroker',
         effect: iam.Effect.ALLOW,
         actions: ['lambda:InvokeFunction'],
         resources: [props.githubTokenBrokerLambdaArn],
       })
     );
     environmentVariables.GITHUB_TOKEN_BROKER_LAMBDA_ARN = props.githubTokenBrokerLambdaArn;
   }
   ```
4. 環境変数 `GITHUB_TOKEN_SECRET_NAME` の注入を **削除**（Runtime 側では secret 名を知る必要がない）

#### `packages/cdk/lib/agentcore-stack.ts` の変更

1. `GitHubTokenBroker` construct を `AgentCoreRuntime` より **前** に生成（循環参照なし）
2. `AgentCoreRuntime` に `githubTokenBrokerLambdaArn: broker.functionArn` を渡す
3. Runtime 作成後に broker 側の Lambda Resource-based policy に Runtime 実行ロール ARN を追加:
   ```ts
   broker.lambdaFunction.addPermission('AllowAgentCoreRuntimeInvoke', {
     principal: new iam.ArnPrincipal(this.agentRuntime.runtime.executionRole.roleArn),
     action: 'lambda:InvokeFunction',
   });
   ```
4. `props.githubTokenSecretName` と `envConfig.githubTokenSecretName` の **消費先を broker のみに変更**（Runtime 側からは切り離す）

### `startup.sh` の書き換え

変更前 (抜粋):
```bash
GITHUB_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "$GITHUB_TOKEN_SECRET_NAME" \
  --query 'SecretString' \
  --output text \
  --region "${AWS_REGION:-us-east-1}" 2>&1)
```

変更後:
```bash
if [ -n "$GITHUB_TOKEN_BROKER_LAMBDA_ARN" ]; then
  echo "[INFO] Invoking GitHub Token Broker Lambda: $GITHUB_TOKEN_BROKER_LAMBDA_ARN"

  INVOKE_PAYLOAD=$(mktemp)
  aws lambda invoke \
    --function-name "$GITHUB_TOKEN_BROKER_LAMBDA_ARN" \
    --payload '{}' \
    --cli-binary-format raw-in-base64-out \
    --region "${AWS_REGION:-us-east-1}" \
    "$INVOKE_PAYLOAD" > /dev/null 2>&1

  GITHUB_TOKEN=$(python3 -c "import json,sys; print(json.load(open('$INVOKE_PAYLOAD')).get('token',''))")
  rm -f "$INVOKE_PAYLOAD"

  if [ -z "$GITHUB_TOKEN" ]; then
    echo "[WARN] Broker Lambda returned empty token — skipping gh auth"
  else
    echo "$GITHUB_TOKEN" | gh auth login --with-token 2>&1 || \
      echo "[WARN] gh auth login failed — GitHub CLI tools will not be available"
    gh auth status 2>&1 || true
  fi

  # 起動後は broker ARN を環境変数から除去（Agent プロセスへのヒント露出を抑制）
  unset GITHUB_TOKEN_BROKER_LAMBDA_ARN
  unset GITHUB_TOKEN
fi
```

要点:
- `GITHUB_TOKEN_SECRET_NAME` は Runtime に届かないので参照しない
- 取得後 `GITHUB_TOKEN_BROKER_LAMBDA_ARN` を `unset` して、Agent プロセスが「どの Lambda を叩けば token が出るか」を知らない状態にする（露出抑制）
- `GITHUB_TOKEN` 自体も `unset`（gh CLI は `~/.config/gh/hosts.yml` に永続化するので env には残さない）

### agent 側 config (`packages/agent/src/config/index.ts`) の変更

- `GITHUB_TOKEN_SECRET_NAME` を **削除**（Runtime からは知り得ない値に変わる）
- `GITLAB_TOKEN_SECRET_NAME`、`GITLAB_HOST` を **削除**

## GitLab 削除タスク一覧

| ファイル | 削除対象 |
|---|---|
| `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts` | `gitlabTokenSecretName`, `gitlabHost` props / 環境変数注入 / `SecretsManagerGitLabTokenAccess` statement |
| `packages/cdk/lib/agentcore-stack.ts` | `gitlabTokenSecretName`, `gitlabHost` props / Runtime への受け渡し (618-620 行付近) |
| `packages/cdk/config/environment-types.ts` | `gitlabTokenSecretName`, `gitlabHost` (126-139 行) |
| `packages/cdk/config/environments.ts` | 各環境の GitLab 関連エントリ（もしあれば） |
| `packages/agent/scripts/startup.sh` | GitLab ブロック全体 (31-65 行) |
| `packages/agent/src/config/index.ts` | `GITLAB_TOKEN_SECRET_NAME`, `GITLAB_HOST` (75-76 行) |
| `docker/agent.Dockerfile` | `glab` インストールブロック (35 行コメント / 57-63 行) |

CDK 側の IAM suppression (`agentcore-stack.ts` 内の `AwsSolutions-IAM5` suppressions) で GitLab secret に言及している箇所がないか最終確認する。

## 実装タスク（実行順）

### Phase 1: GitLab 削除
1. `agentcore-runtime.ts` から GitLab props・env・IAM statement を削除
2. `agentcore-stack.ts` から GitLab props・Runtime への受け渡しを削除
3. `environment-types.ts` / `environments.ts` から GitLab フィールドを削除
4. `packages/agent/src/config/index.ts` から GitLab env schema を削除
5. `packages/agent/scripts/startup.sh` の GitLab ブロック削除
6. `docker/agent.Dockerfile` から `glab` インストール削除、コメント修正
7. `npm run build`（ルート）と `cdk synth` で型/構成エラーなし確認

### Phase 2: GitHub Token Broker Lambda
8. `packages/lambda-tools/brokers/github-token-broker/` を新設
   - `package.json` — `@aws-sdk/client-secrets-manager` 依存
   - `src/handler.ts` — 入力無視、`GITHUB_TOKEN_SECRET_NAME` で secret を取得、`{ token }` を返す
   - `tsconfig.json`
   - `jest.config.js` と handler の単体テスト (Secrets Manager client を mock)
9. ルート `package.json` workspaces に `packages/lambda-tools/brokers/*` を追加（現状の glob に含まれるか確認）
10. `packages/cdk/lib/constructs/agentcore/github-token-broker.ts` を新設
11. `agentcore-stack.ts` に broker 生成 → Runtime 生成 → broker への resource-based policy 追加の配線
12. `agentcore-runtime.ts` を broker ARN ベースに書き換え（`githubTokenSecretName` → `githubTokenBrokerLambdaArn`）
13. `startup.sh` を `aws lambda invoke` 方式に書き換え
14. `packages/agent/src/config/index.ts` から `GITHUB_TOKEN_SECRET_NAME` を削除

### Phase 3: 検証
15. ユニットテスト: broker handler (`jest`)
16. `cdk synth` → 生成された CloudFormation で:
    - Runtime 実行ロールに `secretsmanager:GetSecretValue` が **ない** こと
    - broker Lambda の実行ロールに対象 secret のみ付与されていること
    - broker Lambda の resource-based policy に Runtime 実行ロール ARN があること
17. `cdk deploy` → コンテナログで `gh auth status` が成功していること
18. `execute_command` 経由で `aws secretsmanager get-secret-value` を試行し、`AccessDenied` になることを確認（Runtime 実行ロールから権限が剥奪されたことの回帰テスト）
19. `execute_command` 経由で `aws lambda invoke` を broker に対して試行し、この経路も遮断されていること（※ startup.sh 完了後は `GITHUB_TOKEN_BROKER_LAMBDA_ARN` が unset されているため ARN を知らない前提だが、Agent が ARN を推測して叩けるケースも残るので、それでも invoke できないように resource-based policy の Principal が `arn:...:assumed-role/.../BedrockAgentCore` ではなく execution role ARN に限定されている挙動を確認）

    **注意**: Lambda resource-based policy の Principal は Role ARN で指定するが、実際に invoke する Principal は assumed-role の Session ARN になる。`iam.ArnPrincipal(executionRole.roleArn)` 指定で両方マッチするのが AWS IAM の挙動なので、Agent の子プロセスも invoke 可能 **である点には注意が必要**。これは startup.sh 完了後に `unset` で ARN を隠蔽することで緩和するが、Agent が ARN を推測・列挙する経路は残ることを README に明記する。

## 残留リスクと README への明記事項

1. **post-startup の token 漏洩**: `~/.config/gh/hosts.yml` に平文で永続化される。Agent 脱出時には読み取られる。 → 恒久対策は将来の GitHub App installation token 化 or GitHub 操作の Lambda Tool 化
2. **broker Lambda ARN の推測**: CloudFormation stack outputs / リソース命名規則から Agent が推測して `aws lambda invoke` することは技術的に可能（Runtime 実行ロールが `lambda:InvokeFunction` を持つため）。ただし戻り値は固定 1 つの secret に限定されるので、blast radius は PAT 1 本のみ
3. **監査**: broker Lambda 経由でない `secretsmanager:GetSecretValue` 呼び出しはこの構成では発生しないはずなので、CloudTrail で即異常検知可能。GuardDuty / CloudTrail アラームの設定を README に推奨として記載

## 想定される cdk-nag 変更

- `agentcore-runtime.ts` の suppression で Secrets Manager suffix wildcard に言及していた箇所は、権限自体が消えるので suppression も不要になる可能性が高い
- broker Lambda 側の実行ロールに `secretsmanager` wildcard suffix が残るので、suppression を **broker construct に移動** する

## ロールバック計画

- GitLab 削除は後方互換を破壊する（env config に `gitlabTokenSecretName` を残していたデプロイ環境では synth エラーになる）ので、削除前にデプロイ環境の `environments.ts` から明示的に除去してから実施
- Phase 2 での動作不良時は、`agentcore-runtime.ts` の `secretsmanager:GetSecretValue` statement と startup.sh の旧ブロックを `git revert` で一括戻せる粒度で commit を分ける
