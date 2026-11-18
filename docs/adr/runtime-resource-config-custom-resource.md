# AgentCore Runtime のセッションサイズを Custom Resource で適用する（暫定策）

## ステータス

暫定。CloudFormation が `ResourceConfigurations` に対応した時点で廃止する（後述の「廃止手順」）。

## 背景

AgentCore Runtime V2 では、`resourceConfigurations[].minimumMemoryInMiB`（1024 / 2048 / 4096 / 8192）でセッションごとの確保量（baseline）を指定できる。これを `environments.ts` の `runtimeMinimumMemoryMiB` で管理者が指定できるようにした。

ただし、各レイヤーの対応状況が揃っていない（2026-11-18 時点）。

| レイヤー | 対応 |
|---|---|
| AgentCore control plane API（`UpdateAgentRuntime`） | 対応済み |
| AWS SDK JS ≥ 3.1171 | 対応済み |
| aws-cdk-lib 2.277（L1 / L2 `minimumMemory`） | 対応済み。テンプレートに出力される |
| CloudFormation `AWS::BedrockAgentCore::Runtime` スキーマ | **未対応**。`extraneous key [ResourceConfigurations] is not permitted` でスタック更新が失敗する |

CDK の L2 にサイズを渡すと、デプロイの時点で必ず失敗する。

## 決定

`RuntimeResourceConfig` Custom Resource（`packages/cdk/lib/constructs/agentcore/runtime-resource-config.ts`、ハンドラは `packages/cdk/lambda/runtime-resource-config/`）を追加し、CloudFormation で Runtime を更新した後に、control plane API でサイズを適用する。

- `UpdateAgentRuntime` は設定全体を置き換える API なので、`GetAgentRuntime` で取得した現在の設定をそのまま送り返し、`resourceConfigurations` だけを差し替える。
- CloudFormation の Runtime 更新は `resourceConfigurations` を送らない。API の仕様では、省略は「従量課金に戻す」を意味する。そのため Custom Resource のプロパティに Runtime の `AgentRuntimeVersion` を含め、Runtime が更新されるたびに Custom Resource も再実行してサイズを適用し直す。
- 処理は Provider framework の `isComplete` で行う。UPDATING の間は待ち、READY かつサイズが希望と違うときだけ更新し、一致したら完了とする。CloudFormation 自身の更新や V2 の snapshot 構築と競合しても `ConflictException` にならない。
- Custom Resource は、サイズを指定していない環境も含めて **V2 の Runtime すべてに作る**。サイズを外す操作は、`MinimumMemoryInMiB: ''` への **Update** として扱い、従量課金に戻す。
- **Delete は API を呼ばずに完了する**。Delete が起きるのは、スタックの削除、Runtime の置き換え、この暫定策の廃止のいずれかだけになる。
  - 廃止のとき、CloudFormation は先に（cleanup フェーズより前に）サイズ付きで Runtime を更新している。ここで従量課金に戻すと、適用されたばかりのサイズを消してしまう。
  - 削除される Runtime を更新しても、snapshot を作り直す時間が無駄になるだけである。
  - Delete で例外を出すと、スタックが `DELETE_FAILED` で止まる。
- IAM は `GetAgentRuntime` / `UpdateAgentRuntime`（この Runtime の ARN に限定）と、実行ロールへの `iam:PassRole`（`PassedToService=bedrock-agentcore`）だけにする。PUBLIC ネットワークでは、これで足りることを dev で確認した。VPC モードに切り替える場合は、CloudFormation ハンドラが使う `ec2:*NetworkInterface` などが追加で必要になる可能性がある。

### 既知の副作用

- Runtime の変更を含むデプロイでは、CloudFormation の更新と Custom Resource の更新が続けて走る。そのため Runtime version と snapshot 構築が 2 回分になり、デプロイ時間も伸びる。
- その間に開始したセッションは、従量課金のサイズ（2 vCPU / 8 GB）で動く。
- Runtime の実際の version は CloudFormation が記録している値より 1 つ進む。CloudFormation のドリフト検出には差分として表示される。
- Custom Resource 自身の更新が失敗して Runtime が `UPDATE_FAILED` になった場合、ロールバック時の Update も同じ Runtime を見て例外を出す。そのためスタックは `UPDATE_ROLLBACK_FAILED` になり、`continue-update-rollback` で手動復旧が必要になる。ロールバックの Update は通常の Update と区別できないため、受け入れている。

## 採用しなかった案

- **CloudFormation の対応を待つ**: 実装の手間はないが、その間サイズを指定できない。
- **`AwsCustomResource` で `UpdateAgentRuntime` を直接呼ぶ**: 1 回の SDK 呼び出しでは「現在の設定を取得してから更新する」ことができない。更新に必要な全フィールドをテンプレート側で組み立てることになり、CloudFormation が管理する設定と二重管理になる。
- **Runtime 自体を Custom Resource で作成・管理する**: 置き換える範囲が広すぎる。CloudFormation が対応した後に L2 へ戻すときも、移行が重くなる。

## 廃止手順

CloudFormation が対応したかどうかは、次のコマンドで確認する。

```bash
aws cloudformation describe-type --type RESOURCE \
  --type-name AWS::BedrockAgentCore::Runtime --query Schema --output text \
  | jq '.properties | has("ResourceConfigurations")'
```

`true` になったら、次を 1 つのリリースで行う。

1. `packages/cdk/config/environment-utils.ts` の `RUNTIME_MINIMUM_MEMORY_CFN_SUPPORTED` を `true` にする。L2 の `minimumMemory` 経由で、CloudFormation がサイズを適用するようになる。
2. `RuntimeResourceConfig` construct、`packages/cdk/lambda/runtime-resource-config/`、`agentcore-runtime.ts` の分岐、`@aws-sdk/client-bedrock-agentcore-control` の devDependency（他で使っていなければ）、このフラグを削除する。
3. この ADR を削除する。

1 と 2 を同じデプロイに含めてよい。CloudFormation がサイズ付きで Runtime を更新した後、cleanup フェーズで Custom Resource が削除される。Custom Resource の Delete は何もしないので、サイズはそのまま維持される。
