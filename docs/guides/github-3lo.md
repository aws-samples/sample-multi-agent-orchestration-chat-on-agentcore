# GitHub MCP with per-user OAuth (3LO)

This optional Gateway target lets the agent call the [GitHub MCP server](https://github.com/github/github-mcp-server) **as the signed-in user**. Each user connects their own GitHub account once; the token is stored in the AgentCore Identity Token Vault and never enters the agent container.

The target is read-only (`https://api.githubcopilot.com/mcp/readonly`) and exposes these tools: `get_me`, `search_repositories`, `list_issues`, `issue_read`, `search_issues`, `list_pull_requests`. Edit `packages/cdk/schemas/github-mcp-tools.json` to change the list (keep `{ "tools": [...] }` shape).

Design and security rationale: [docs/adr/gateway-3lo-github.md](../adr/gateway-3lo-github.md).

## 1. Create a GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
|---|---|
| Homepage URL | Your Moca frontend URL |
| Callback URL | Temporary value (e.g. the frontend URL). Replaced in step 4 |
| Expire user authorization tokens | On (default) |
| Request user authorization (OAuth) during installation | Off |
| Webhook → Active | Off |
| Repository permissions | Metadata: Read-only, Contents: Read-only, Issues: Read-only, Pull requests: Read-only |

After creating the app, note the **Client ID** and click **Generate a new client secret**.

A GitHub App user token can only reach repositories where the app is **installed**. Each user (or org owner) installs it from the app page → **Install App**, selecting the repositories the agent may read.

## 2. Store the client secret

```bash
aws secretsmanager create-secret \
  --name agentcore/<env>/github-oauth \
  --secret-string '{"clientSecret":"<client secret>"}' \
  --region <region>
```

## 3. Configure and deploy

`packages/cdk/config/environments.ts`:

```typescript
dev: {
  githubOAuth: {
    clientId: 'Iv23li...',
    clientSecretName: 'agentcore/dev/github-oauth', // pragma: allowlist secret
  },
},
```

```bash
npm run build && npm run deploy:dev
```

## 4. Register the callback URL

Copy the `GithubOAuthCallbackUrl` output of the `<Stack>Targets` stack (`https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback/...`) into the GitHub App **Callback URL**.

## Usage

Ask the agent something like "List the open issues in my repository owner/repo". The first time, a **Connect GitHub** card appears above the input box. Open it, approve on GitHub, and the `/oauth/callback` page confirms the connection. Then ask again.

The GitHub tools must be enabled on the agent (they appear as `github___*` in the tool list).

## Limitations

- **Triggers (event-driven runs) cannot use these tools.** Triggers run as a shared machine user; the tools are hidden and refused for it.
- **Sub-agents** started via `call_agent` cannot show the Connect card; the tool tells the model to ask the user to make the request directly in the chat. Connect once from a direct chat first.
- **Disconnecting**: there is no per-user Token Vault delete API. Revoke the app at GitHub → Settings → Applications → Authorized GitHub Apps. GitHub App user tokens are short-lived (8 hours; refresh tokens 6 months).
- **Rotating the client secret**: CloudFormation does not re-resolve the secret reference on its own. After updating the secret, run `aws bedrock-agentcore-control update-oauth2-credential-provider` for `<resourcePrefix>-github` (or change `clientId`) so the provider picks it up.
