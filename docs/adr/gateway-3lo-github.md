# AgentCore Gateway 3LO (Authorization Code) サンプル: GitHub MCP 設計

> Status: **Accepted**（Phase 0 検証済み、2026-10-05）
> 参考: [Classmethod: AgentCore Gateway 3LO (GitHub / Slack / Google Calendar)](https://dev.classmethod.jp/articles/amazon-bedrock-agentcore-gateway-3lo-github-slack-google-calendar/), [AWS Blog: Connecting MCP servers to AgentCore Gateway using Authorization Code flow](https://aws.amazon.com/blogs/machine-learning/connecting-mcp-servers-to-amazon-bedrock-agentcore-gateway-using-authorization-code-flow/)

## 背景

Moca の Gateway ターゲットの外部認証は API Key (Tavily など) か 2LO (OneDrive = Microsoft Graph `client_credentials`、scope `.default`) のみで、**エンドユーザー本人の権限で外部 SaaS にアクセスする 3LO の例が無い**。また既存の GitHub 連携は Secrets Manager の共有 PAT (`githubTokenSecretName`) で、全ユーザーが同じ GitHub ID として振る舞う。

## 目的

1. AgentCore Gateway + AgentCore Identity (Token Vault) による 3LO を、最小コストかつセキュアな形でサンプル化する
2. 「共有 PAT」と「ユーザー本人の GitHub ID」の対比で効果を示す（例: 「自分の private repo の Issue を一覧して」の結果がユーザーごとに変わる）

### 非目標

- 認可完了後のツール自動リトライ（ポーリング）。ユーザーに再依頼してもらう
- trigger (EventBridge / マシンユーザー) 経由の 3LO ツール実行。**仕組みで拒否する**（後述 S2）
- Slack / Google Calendar への展開（本設計のパターンを流用して別途）

## 対象サービスの選定

| 候補 | 実装コスト | デモ効果 | 判断 |
|---|---|---|---|
| **GitHub MCP** | 低: ビルトイン Provider (`usingGithub`)、個人アカウントで即作成、審査無し | 高: 自分の private repo/Issue | **採用** |
| OneDrive の 3LO 化 | 低〜中: 既存 OpenAPI スキーマ流用可。Entra ID テナント必須 | 高 | 次点 |
| Slack MCP | 中: ワークスペース管理者権限、`CustomOauth2` + `oauth.v2.user.access`、Bot ユーザー必須の罠 | 中 | 不採用 |
| Google Calendar | 高: GCP 同意画面、OpenAPI 手書き、`access_type=offline` | 最高 | 第2弾候補 |

GitHub は **OAuth App ではなく GitHub App（user-to-server token）を第一候補**とする（理由は S3）。Phase 0 で `GithubOauth2` ベンダーとの互換性を検証し、不可なら OAuth App + 最小 scope にフォールバックする。

## CDK サポート状況 (aws-cdk-lib 2.263.0)

| 要素 | 状況 | 対処 |
|---|---|---|
| MCP `2025-11-25`（elicitation 導入版。3LO 必須） | 定数なし（`MCP_2025_06_18` まで） | `MCPProtocolVersion.of('2025-11-25')` |
| GitHub Credential Provider | L2 `OAuth2CredentialProvider.usingGithub()` | そのまま。`callbackUrl` 属性を出力 |
| MCP Server ターゲット | L2 `GatewayTarget.forMcpServer()` | そのまま |
| `GrantType: AUTHORIZATION_CODE` / `DefaultReturnUrl` | L2 `OAuthConfiguration` に無し、L1 `OAuthCredentialProviderProperty` に有り | `addPropertyOverride` |
| 静的ツールスキーマ `McpToolSchema.InlinePayload` | L2 MCP props に無し、L1 に有り | `addPropertyOverride` |
| Gateway ロール IAM | L2 `fromOauthIdentity` が `GATEWAY_OAUTH_*` / `GATEWAY_OAUTH_COMPLETE_AUTH_PERMS` を `${gatewayName}-*` と token-vault/default にスコープして付与 | 追加不要 |
| `CompleteResourceTokenAuthCommand` | backend 依存の `@aws-sdk/client-bedrock-agentcore` に存在 | そのまま |

静的スキーマを使う理由: 動的同期 (implicit sync) はターゲット作成時に管理者の OAuth 同意が必要で、CDK デプロイが `Needs Authorization` で止まるため。

## Phase 0 検証結果（us-west-2 の使い捨て spike Gateway で実測）

| 項目 | 結果 | 設計への反映 |
|---|---|---|
| `initialize` なし stateless `tools/call` | **ヘッダー `MCP-Protocol-Version: 2025-11-25` だけで -32042 が返る**。ヘッダー無しだと `isError` のツール結果「URL elicitation requires MCP version 2025-11-25 or newer」になる | Agent の MCP クライアントは全リクエストにこのヘッダーを付ける |
| CFN の escape hatch | `GrantType` / `DefaultReturnUrl` / `McpToolSchema.InlinePayload` すべて受理。InlinePayload は **`{"tools":[...]}` 形式必須**（配列だと `mcpToolSchema must be an object with 'tools' array`） | `schemas/github-mcp-tools.json` は `{ tools }` |
| スキーマ外ツールの呼び出し | `-32602 Unknown tool` で Gateway が拒否 | S3 の前提が成立 |
| return URL の検証（S4） | Gateway の workload identity（名前 = Gateway ID）の `allowedResourceOauth2ReturnUrls` が **空だと無検証**。1 件でも登録すると `defaultReturnUrl` も検証され、未登録なら `Callback URL ... is not registered` で失敗。`_meta` 経由の上書き候補キーはいずれも無視された | allow-list を frontend `/oauth/callback` だけに固定（AwsCustomResource で `UpdateWorkloadIdentity`）。**flowId ストアは不要** |
| Token Vault のユーザー単位削除 API（S7） | 存在しない（data plane は `get-resource-oauth2-token` 系のみ） | ガイドに GitHub 側での取り消し手順を記載 |
| 認可 URL | `https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/authorize?request_uri=...`。GitHub へは PKCE(S256) + `resource` 付きで 302 | host 検証はこのホスト + `/identities/` パス |
| session URI | callback の `session_id` = `urn:ietf:params:oauth:request_uri:...`。同意前・期限切れは **`AccessDeniedException`「Invalid or expired session」**（ValidationException ではない） | backend で形式を検証。この AccessDenied は 400 に、IAM 拒否（`not authorized to perform`）は 502 に分ける |
| GitHub MCP | `https://api.githubcopilot.com/mcp/readonly` が実在（protected resource metadata あり） | 読み取り専用エンドポイントを使用（S3 の多層防御） |

GitHub App との互換性と session binding の不一致拒否は、実 GitHub App を使った dev E2E で確認する。

dev E2E で判明: `CompleteResourceTokenAuth` は code→token 交換を**呼び出し元の資格情報で**行い、AgentCore Identity 管理の provider client secret（`bedrock-agentcore-identity!default/oauth2/{providerName}-*`）を読む。backend ロールに当該 secret の `secretsmanager:GetSecretValue` が無いと `AccessDeniedException ... not authorized to perform: secretsmanager:GetSecretValue` で失敗する。backend が読めるのは GitHub App の client secret のみで、ユーザーのトークンは Token Vault から出ない（残存リスクとして記載）。

## 全体アーキテクチャ

```
 ┌──────────────┐  JWT(user)   ┌────────────────┐  JWT(user)   ┌───────────────────────┐
 │  Frontend    │─────────────▶│ Agent          │─────────────▶│ AgentCore Gateway     │
 │  (React SPA) │◀─ NDJSON ────│ (AgentCore     │◀─ JSON-RPC ──│  MCP 2025-11-25       │
 │              │   stream     │  Runtime)      │              │  target: github (3LO) │
 │  /oauth/     │              └────────────────┘              └──────────┬────────────┘
 │   callback   │                                                         │ GetWorkloadAccessTokenForJWT
 │              │  JWT(user)   ┌────────────────┐                         │ GetResourceOauth2Token
 │              │─────────────▶│ Backend        │  CompleteResource       ▼
 │              │ POST /oauth/ │ (Express on    │  TokenAuth    ┌───────────────────────┐
 │              │   complete   │  Lambda)       │──────────────▶│ AgentCore Identity    │
 └──────┬───────┘              └────────────────┘               │  Token Vault          │
        │ (browser redirect)                                    │  key = workload+user  │
        ▼                                                       └──────────┬────────────┘
 ┌──────────────┐  authorize / code exchange                               │ access token
 │ github.com   │◀─────────────────────────────────────────────────────────┘
 │ (GitHub App) │                                     ┌────────────────────────────────┐
 └──────────────┘                                     │ GitHub MCP                     │
                    Gateway ── Bearer(user's GH token)▶│ api.githubcopilot.com/mcp/     │
                                                      └────────────────────────────────┘
```

GitHub トークンは **Gateway と Token Vault の内側にのみ存在し、Agent Runtime コンテナに入らない**。`execute_command` によるサンドボックス脱出時にも流出しない点が、既存の共有 PAT（`gh` の hosts.yml に展開）より優れる（cf. `github-token-broker-lambda.md`）。

## シーケンス

### A. 初回呼び出し（未認可）→ 認可 → 再依頼

```
User      Frontend          Agent             Gateway            Identity/TokenVault     GitHub
 │ "自分のIssue一覧" │               │                  │                       │                │
 │──────────────────▶│ POST /invoke  │                  │                       │                │
 │                   │──(JWT)───────▶│ tools/call       │                       │                │
 │                   │               │──(JWT)──────────▶│ GetWorkloadAccess     │                │
 │                   │               │                  │  TokenForJWT ────────▶│                │
 │                   │               │                  │ GetResourceOauth2Token▶│ (token なし)  │
 │                   │               │                  │◀── authorizationUrl ──│                │
 │                   │               │◀── error -32042 ─│   + sessionUri        │                │
 │                   │               │   data.elicitations[{mode:url,url,...}]  │                │
 │                   │               │                  │                       │                │
 │                   │               │ (1) URL を request-context の sink へ      │                │
 │                   │               │ (2) LLM には URL を含まない固定文言を返す   │                │
 │                   │◀ serverAuthorizationRequiredEvent {url, elicitationId, target}            │
 │                   │  ※ host 検証 (AgentCore Identity ドメイン) → 専用カード表示              │
 │◀─ 認可カード ─────│               │                  │                       │                │
 │ [GitHubと連携]    │               │                  │                       │                │
 │──────────────────────────────── browser ─────────────────────────────────────▶│ authorize     │
 │                   │               │                  │                       │◀── code ───────│
 │                   │               │                  │                       │ code→token 交換│
 │◀──── 302 DefaultReturnUrl = <frontend>/oauth/callback?session_id=<sessionUri> │                │
 │                   │               │                  │                       │                │
 │  → B へ                                                                                        │
```

### B. コールバック（session binding）

```
Browser(/oauth/callback)        Backend                         Identity
 │ 1. session_id を読み取り          │                                  │
 │ 2. history.replaceState でクエリ除去│                                 │
 │ 3. POST /oauth/complete          │                                  │
 │    {sessionUri} + JWT(user) ────▶│ 4. マシンユーザー JWT なら 403    │
 │                                  │ 5. CompleteResourceTokenAuth     │
 │                                  │    sessionUri,                   │
 │                                  │    userIdentifier.userToken=JWT ▶│ 6. フロー開始者と
 │                                  │                                  │    JWT の user が一致?
 │                                  │◀──────────── OK / mismatch ──────│    → token を Vault に確定
 │◀── 200 / 4xx ────────────────────│                                  │
 │ 7. 「連携完了」表示 → 固定パス /chat/:sessionId へ（クエリ由来の遷移先は使わない）
```

### C. 2 回目以降

```
Agent ── tools/call (JWT) ──▶ Gateway ── Vault から user の token 取得 ──▶ GitHub MCP ──▶ 結果
```

## コンポーネント別設計

### CDK

- `config/environment-types.ts`: opt-in の `githubOAuth?: { clientId: string; clientSecretName: string }`。secret は `agentcore/{env}/github-oauth`。未設定ならターゲット自体を作らない（OneDrive と同パターン）
- `constructs/agentcore/agentcore-gateway.ts`: `supportedVersions` に `MCPProtocolVersion.of('2025-11-25')` を追加（既存 `2025-03-26` は残す）
- `agentcore-gateway-target-stack.ts`:
  - `OAuth2CredentialProvider.usingGithub(..., { clientId, clientSecret: SecretValue.secretsManager(...) })`（`unsafePlainText` 禁止）
  - `GatewayTarget.forMcpServer({ endpoint, credentialProviderConfigurations: [fromOauthIdentity(provider, { scopes })] })`
  - escape hatch:
    - `TargetConfiguration.Mcp.McpServer.McpToolSchema.InlinePayload` ← `schemas/github-mcp-tools.json`（読み取り系 5〜6 ツール）
    - `CredentialProviderConfigurations.0.CredentialProvider.OauthCredentialProvider.GrantType = AUTHORIZATION_CODE`
    - `...OauthCredentialProvider.DefaultReturnUrl = <frontendUrl>/oauth/callback`
  - `frontendUrl` は別スタックの値。props 受け渡しか envConfig かを実装時に決定
  - CfnOutput: Provider の `callbackUrl`（GitHub App に登録する値）
- backend ロール: `bedrock-agentcore:CompleteResourceTokenAuth`（リソースは token-vault/default と当該 provider に限定）

### Agent

- `libs/mcp/client.ts`: `error.code === -32042` を `McpAuthorizationRequiredError { url, elicitationId, message }` として送出（現状は `data` を捨てて汎用 Error 化している）
- `runtime/tools/mcp-converter.ts`: 上記エラーを捕捉し、
  1. request-context (AsyncLocalStorage) の event sink に `{ url, elicitationId, targetName }` を積む
  2. LLM には **URL を含まない** 固定のツール結果を返す（例: 「外部サービスの認可待ち。画面のカードから連携後に再依頼するようユーザーに伝える」）
- `handlers/stream-handler.ts`: sink を drain して `serverAuthorizationRequiredEvent` を NDJSON で送出
- マシンユーザー JWT（`agent/invoke` scope / machine client id）の場合、3LO ターゲットのツールを tool list から除外
- Phase 0 結果次第で `initialize` / `MCP-Protocol-Version` ヘッダーを追加

### Backend

- `POST /oauth/complete`、body `{ sessionUri: string }`（`@moca/api-schema` の zod パターン）
- 既存認証ミドルウェアの後段。マシンユーザー JWT は 403
- `CompleteResourceTokenAuthCommand({ sessionUri, userIdentifier: { userToken } })`。`userToken` は Gateway に渡したのと同種の JWT を使う
- JWT / `sessionUri` をログ出力しない

### Frontend

- `serverAuthorizationRequiredEvent` 受信 → 専用カード（`ui-design` skill 準拠、i18n ja/en）
  - URL の host が AgentCore Identity のドメイン（`bedrock-agentcore.<region>.amazonaws.com`）であることを検証。不一致なら表示しない
- `/oauth/callback` ルート（認証済みレイアウト配下）: B の 1〜7。完了を `BroadcastChannel('moca-oauth')` で元のチャットタブへ通知しカードを消す
- 外部リンク遷移は `noopener,noreferrer`（認可 URL を開く側）。ブラウザ既定の `strict-origin-when-cross-origin` により別オリジンへ query は送られない

## セキュリティ設計

| # | 脅威 | 深刻度 | 対策 |
|---|---|---|---|
| S1 | プロンプトインジェクションで LLM に偽の「認可リンク」を出させるフィッシング。LLM の URL 改変・幻覚 | 高 | 認可 URL を LLM に渡さず out-of-band イベントで送る。Frontend で host 検証し専用カードのみに表示。LLM 文中の URL は認可導線として扱わない |
| S2 | trigger はマシンユーザー（`client_credentials`、`trigger/src/services/auth-service.ts:74`）で Gateway を呼ぶ。Token Vault のキーが全ユーザー共通の machine identity になり、一度紐付くと全ユーザーの trigger が同じ GitHub token を使う | 高 | Agent でマシンユーザー時に 3LO ツールを除外、Backend `/oauth/complete` でマシンユーザー拒否。可能なら Gateway interceptor でも拒否（多層） |
| S3 | private データ + 信頼できない入力（公開 Issue 本文等）+ 外部送信経路（Web 検索・画像生成等の他ツール）が揃う。OAuth App の `repo` scope は全 private repo の read/write | 高 | GitHub App で `Contents: read` / `Issues: read` / `Metadata: read` 等の最小権限・8h 失効。静的スキーマを読み取り系に限定し、スキーマ外ツールを Gateway が拒否することを Phase 0 で確認。GitHub MCP の read-only エンドポイント有無も確認。ガイドで「GitHub ツールは外部送信系ツールと同居させない専用エージェントに割り当てる」ことを推奨 |
| S4 | Return URL の呼び出し時上書きによる token 横取り: 攻撃者が自分の JWT でフロー開始し return URL を自ドメインに変更 → 被害者が同意 → 攻撃者が自分の JWT で complete → 被害者の GitHub token が攻撃者の Vault に入る | 中〜高 | workload identity の allowed return URLs を自 frontend の `/oauth/callback` のみに制限（Phase 0 で可否確認）。→ **Phase 0 で制限可能と確認、実装済み** |
| S5 | `session_id` 漏洩（Referer、ブラウザ履歴、CloudFront/WAF/backend ログ）→ S4 と同等の横取り | 中 | `history.replaceState`、ブラウザ既定の referrer policy、backend は JWT / sessionUri をログしない、10 分失効（Identity 側仕様）。CloudFront ログは残存リスク（下記） |
| S6 | Open redirect（callback 後の遷移先をクエリから取る） | 中 | 遷移先は固定パス |
| S7 | 失効手段の欠如: OAuth App token は無期限。Cognito ユーザー削除後も Vault に残存。連携解除 UI 無し | 中 | GitHub App で短命化。Token Vault のユーザー単位削除 API の有無を Phase 0 で調査、無ければガイドに GitHub 側の取り消し手順を記載 |
| S8 | private repo 内容が Session DynamoDB / AgentCore Memory / トレース span 属性（`gen_ai.*.messages`）に残り、AWS アカウント管理者が閲覧可能 | 中 | 残存リスクとして明記（サンプルの範囲では許容） |
| S9 | client secret の平文混入 | 低 | `SecretValue.secretsManager` の dynamic reference のみ |
| S10 | 既存の Gateway REQUEST interceptor が全 `tools/call` の arguments に `_context`（userId / identityId / storagePath）を注入しており、第三者の MCP サーバーへ内部識別子が漏れる | 中 | interceptor は 3LO ターゲット（`USER_DELEGATED_TARGETS`）では注入しない。同時にマシンユーザーの呼び出しを `transformedGatewayResponse` で短絡拒否（S2 の多層防御） |

### 単純な固定 return URL でも session binding で守られるケース

攻撃者がフロー開始 → URL を被害者に踏ませる → 被害者の同意後、**固定**の Moca callback で被害者の JWT により complete → Identity が「開始者 ≠ 完了者」で拒否。したがって S4/S5 が塞がれていれば、記事にある flowId ストアは必須ではない。

S5 の残存: CloudFront アクセスログは callback リクエストの query と同一オリジンの Referer を記録しうる。悪用には「攻撃者が自分で開始したフローを被害者に同意させる」＋「AWS アカウント内のログ閲覧権限」が必要で、サンプルでは許容する。

### flowId ストア（不採用: S4 は allow-list で塞がった）

```
Frontend: カード表示時  POST /oauth/pending {elicitationId}  → DDB {hash(flowId), userId, PENDING, ttl=15m}
Callback:               POST /oauth/complete {sessionUri}
Backend:  ConditionExpression  status=PENDING AND userId=:caller AND ttl>now  → COMPLETED (one-time)
          → 成功時のみ CompleteResourceTokenAuth
```

## 却下した代替案

| 代替案 | 却下理由 |
|---|---|
| 認可 URL を LLM 経由（Markdown リンク）で提示 | S1。最も実装は安いがフィッシング導線になる |
| Hook でのポーリング自動リトライ（記事方式） | 完了通知 API が無く固定待ちになる。実装コストに対しデモ効果が小さい |
| 動的ツール同期 (implicit sync) | デプロイ時に管理者の OAuth 同意が必要で CDK が止まる。全 44 ツールが露出し S3 が悪化 |
| OAuth App + `repo` scope | 読み取り専用にできない・無期限 token（S3/S7）。GitHub App 不可時のフォールバックに留める |
| L1 `CfnGatewayTarget` で全体を記述 | L2 の IAM 自動付与（スコープ済み）を失う。不足分のみ escape hatch で補う |

## 実装フェーズ

```
Phase 0  Spike (dev)          ──▶ 結果で Phase 1/2 の分岐を確定
  ├─ initialize 無し stateless tools/call で -32042 が返るか / MCP-Protocol-Version ヘッダー要否
  ├─ 2025-11-25 追加で既存ターゲットに回帰が無いか
  ├─ CFN が InlinePayload / GrantType / DefaultReturnUrl を受理するか
  ├─ GithubOauth2 ベンダー × GitHub App (user-to-server) の互換性
  ├─ return URL を allowlist で制限できるか / 呼び出し時上書きの可否     ← S4 の分岐点
  ├─ スキーマ外ツール名の tools/call を Gateway が拒否するか            ← S3
  └─ Token Vault のユーザー単位 token 削除 API の有無                   ← S7
Phase 1  CDK                  provider / target / escape hatch / IAM / outputs
Phase 2  Agent                -32042 typed error / sink / stream event / machine-user 除外 + jest
Phase 3  Backend              POST /oauth/complete (+ flowId ストア if S4 不可) + jest
Phase 4  Frontend             認可カード + host 検証 / /oauth/callback + vitest
Phase 5  Docs                 docs/guides/github-3lo.md（GitHub App 作成 → デプロイ → callbackUrl 登録の順）
                              本 ADR の Status を Accepted に更新し Phase 0 結果を反映
```

テスト方針: agent / backend は jest、frontend は vitest。Phase 0 の検証結果のうち回帰しうるもの（-32042 のパース、マシンユーザー拒否、host 検証）はユニットテストで固定する。

## 残存リスク

- S3: 最小権限・ツール限定でも、読み取れる範囲の private データが同一エージェント内の他ツールへ流れうる。エージェント構成はユーザー責任
- S8: 会話・トレースへの private データ残存
- 認可完了後の再依頼が手動（UX 上の制約）
- `call_agent` のサブエージェント内で発生した認可要求はカードとして表示されない（サブエージェントは独自の request context で動き、stream handler が drain しない）。`surfacesAuthorizationPrompts` が立っていない context ではツール結果を「直接チャットで依頼して」に切り替え、存在しない UI を案内させない。サブエージェントは親の `isMachineUser` を引き継ぐ
- S5 の CloudFront ログ経由の session URI 露出（上記）
- backend 実行ロールが GitHub App の client secret を読める（session binding 完了に必須）。漏洩しても App 単体ではユーザーのリソースにアクセスできないが、App を騙るフィッシングには使えうる
