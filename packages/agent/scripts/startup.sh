#!/bin/bash
# Note: `set -e` is intentionally omitted so that missing secrets (ResourceNotFoundException)
# do not abort the startup script and crash the container. Each optional secret is handled
# gracefully: a [WARN] message is printed and execution continues.

echo "Starting AgentCore Runtime..."
echo "AWS_REGION: ${AWS_REGION:-us-east-1}"

# Retrieve GitHub Token via the dedicated Token Broker Lambda and authenticate.
# The broker holds the only `secretsmanager:GetSecretValue` permission on the
# GitHub PAT; the Runtime execution role is restricted to `lambda:InvokeFunction`
# on this single broker ARN. We unset GITHUB_TOKEN_BROKER_LAMBDA_ARN after use
# so the agent process cannot see the broker ARN and re-invoke it.
if [ -n "$GITHUB_TOKEN_BROKER_LAMBDA_ARN" ]; then
  echo "[INFO] Invoking GitHub Token Broker Lambda"

  INVOKE_PAYLOAD=$(mktemp)
  INVOKE_STDERR=$(mktemp)

  # NOTE: stderr is captured and logged on failure so operators can see the
  # underlying reason (AccessDenied / ResourceNotFound / credentials missing
  # / etc). stdout is the aws-cli invocation metadata JSON — we only care
  # about exit code, so it's dropped. The actual response payload is
  # written to $INVOKE_PAYLOAD.
  #
  # `--cli-binary-format raw-in-base64-out` is intentionally omitted: the
  # Agent container ships AWS CLI v1 (installed via `pip3 install awscli`
  # in docker/agent.Dockerfile), which does not recognise that flag and
  # rejects it with `Unknown options`. v1 already treats `--payload` as raw
  # string by default, so no flag is needed. If the image is ever upgraded
  # to v2, add the flag back (or switch to `--payload file://...`).
  aws lambda invoke \
    --function-name "$GITHUB_TOKEN_BROKER_LAMBDA_ARN" \
    --payload '{}' \
    --region "${AWS_REGION:-us-east-1}" \
    "$INVOKE_PAYLOAD" > /dev/null 2> "$INVOKE_STDERR"
  INVOKE_EXIT=$?

  if [ $INVOKE_EXIT -ne 0 ]; then
    echo "[WARN] GitHub Token Broker Lambda invocation failed (exit=$INVOKE_EXIT) — skipping gh auth"
    # stderr from aws-cli is non-sensitive (AccessDenied / ResourceNotFound
    # / usage errors). We do NOT dump the response payload here because a
    # partial / unexpected response could contain the token itself.
    if [ -s "$INVOKE_STDERR" ]; then
      echo "[WARN] aws lambda invoke stderr:"
      sed -e 's/^/[WARN]   /' "$INVOKE_STDERR"
    fi
    GITHUB_TOKEN=""
  else
    if command -v jq >/dev/null 2>&1; then
      GITHUB_TOKEN=$(jq -r '.token // ""' "$INVOKE_PAYLOAD" 2>/dev/null || echo "")
    else
      # jq is not installed in the image; use python3 (shipped with Debian
      # slim) with stdin to avoid shell-quoting pitfalls.
      GITHUB_TOKEN=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("token","") if isinstance(d, dict) else "")' < "$INVOKE_PAYLOAD" 2>/dev/null || echo "")
    fi

    if [ -z "$GITHUB_TOKEN" ]; then
      # Deliberately NOT logging the response payload: if the broker ever
      # returns an unexpected shape that still embeds the secret, a preview
      # would leak it. Operators can reproduce locally if they need detail.
      echo "[WARN] Broker Lambda returned empty or unparseable token"
    fi
  fi

  rm -f "$INVOKE_PAYLOAD" "$INVOKE_STDERR"

  if [ -z "$GITHUB_TOKEN" ]; then
    echo "[WARN] Skipping gh auth login — no token available"
  else
    echo "$GITHUB_TOKEN" | gh auth login --with-token 2>&1 || \
      echo "[WARN] gh auth login failed — GitHub CLI tools will not be available"
    gh auth status 2>&1 || true
  fi

  # Remove broker ARN and raw token from the agent process environment so
  # a compromised tool cannot re-invoke the broker or read the PAT from env.
  # (gh CLI persists the token to ~/.config/gh/hosts.yml — that file remains
  # reachable from the agent sandbox; see docs/github-token-broker-lambda.md
  # for the residual-risk discussion.)
  unset GITHUB_TOKEN_BROKER_LAMBDA_ARN
  unset GITHUB_TOKEN
else
  echo "[INFO] GITHUB_TOKEN_BROKER_LAMBDA_ARN not set — skipping GitHub CLI authentication"
fi

# Start application with AWS Distro for OpenTelemetry (ADOT) auto-instrumentation
echo "Starting Node.js application with AWS ADOT auto-instrumentation..."
exec node --require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register dist/index.js
