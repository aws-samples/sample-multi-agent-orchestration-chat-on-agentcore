/**
 * GitHub Token Broker Lambda
 *
 * Returns the GitHub Personal Access Token stored in a fixed Secrets Manager
 * secret whose name is baked into the Lambda's environment at deploy time.
 *
 * This Lambda is intentionally NOT registered as an AgentCore Gateway target.
 * It exists so the AgentCore Runtime execution role can receive
 * `lambda:InvokeFunction` scoped to this single ARN in place of the broad
 * `secretsmanager:GetSecretValue` permission it used to carry. The entrypoint
 * script (`packages/agent/scripts/startup.sh`) calls it once at container
 * boot to hand the PAT to `gh auth login`.
 *
 * Confused-Deputy hardening:
 *   • The `SecretId` is read from `GITHUB_TOKEN_SECRET_NAME` only.
 *   • Any fields the caller puts in the event (`SecretId`, etc.) are ignored.
 *   • The `SecretString` itself is never logged; we log only the secret name.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const SECRET_NAME = process.env.GITHUB_TOKEN_SECRET_NAME;

const client = new SecretsManagerClient({});

export interface BrokerResponse {
  token: string;
}

export const handler = async (event: unknown): Promise<BrokerResponse> => {
  if (!SECRET_NAME) {
    // Deploy-time misconfiguration — fail loud so CloudWatch surfaces it.
    throw new Error('GITHUB_TOKEN_SECRET_NAME is not set on the broker Lambda');
  }

  if (event && typeof event === 'object' && Object.keys(event).length > 0) {
    // Confused-Deputy guard: a caller (e.g. the agent process after a
    // hypothetical sandbox escape) must not be able to redirect this broker
    // to a different secret. We ignore every field and surface a warning so
    // unexpected usage is visible in CloudWatch.
    console.warn(
      '[github-token-broker] Ignoring non-empty event payload; broker is hard-wired to a single secret.',
      { secretName: SECRET_NAME, ignoredKeys: Object.keys(event) }
    );
  }

  console.info('[github-token-broker] Fetching secret', { secretName: SECRET_NAME });

  const result = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));

  const token = result.SecretString ?? '';
  if (!token) {
    // Do not throw — startup.sh handles empty-token as "skip gh auth" so the
    // container keeps booting. The warning is enough for operators.
    console.warn('[github-token-broker] Secret has no SecretString value', {
      secretName: SECRET_NAME,
    });
  }

  return { token };
};
