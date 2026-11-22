/**
 * Cognito group lookup for machine-user requests.
 *
 * A regular user's groups come from the verified JWT (`cognito:groups`). A
 * machine user (Trigger / Workflow) acts for `X-Target-User-Id` and its token
 * carries no user groups, so they are read from the User Pool.
 */

import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

/** Long enough to keep a burst of trigger runs well under the Cognito API quota. */
const CACHE_TTL_MS = 15 * 60 * 1000;

let client: CognitoIdentityProviderClient | null = null;
const cache = new Map<string, { groups: string[]; at: number }>();

function getClient(): CognitoIdentityProviderClient {
  client ??= new CognitoIdentityProviderClient({ region: config.AWS_REGION });
  return client;
}

/**
 * Groups of the user whose `sub` is `userId`. Returns [] (base limits) when
 * the lookup fails, so a Cognito outage never blocks a run.
 */
export async function getGroupsForUserSub(userId: string): Promise<string[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.groups;
  try {
    // AdminListGroupsForUser takes the username, which is not always the sub.
    const users = await getClient().send(
      new ListUsersCommand({
        UserPoolId: config.COGNITO_USER_POOL_ID,
        Filter: `sub = "${userId}"`,
        Limit: 1,
      })
    );
    const username = users.Users?.[0]?.Username;
    let groups: string[] = [];
    if (username) {
      const result = await getClient().send(
        new AdminListGroupsForUserCommand({
          UserPoolId: config.COGNITO_USER_POOL_ID,
          Username: username,
        })
      );
      groups = (result.Groups ?? []).map((g) => g.GroupName).filter((n): n is string => !!n);
    }
    cache.set(userId, { groups, at: Date.now() });
    return groups;
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to look up Cognito groups; applying base token limits');
    return [];
  }
}

/** Test hook. */
export function clearGroupCacheForTest(): void {
  cache.clear();
}
