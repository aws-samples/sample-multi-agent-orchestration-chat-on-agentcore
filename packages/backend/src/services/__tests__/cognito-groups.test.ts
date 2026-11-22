/**
 * Machine-user group lookup: sub → username (ListUsers) → groups, cached,
 * and a Cognito failure falls back to the base limits ([]).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../config/index', () => ({
  config: { AWS_REGION: 'ap-northeast-1', COGNITO_USER_POOL_ID: 'ap-northeast-1_pool' },
}));
const send =
  jest.fn<
    (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>
  >();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    CognitoIdentityProviderClient: class {
      send = send;
    },
    ListUsersCommand: class ListUsersCommand extends Cmd {},
    AdminListGroupsForUserCommand: class AdminListGroupsForUserCommand extends Cmd {},
  };
});

import { clearGroupCacheForTest, getGroupsForUserSub } from '../cognito-groups';

const SUB = '0a1b2c3d-0000-4000-8000-000000000001';

beforeEach(() => {
  send.mockReset();
  clearGroupCacheForTest();
});

const respond = () =>
  send.mockImplementation(async (cmd) =>
    cmd.constructor.name === 'ListUsersCommand'
      ? { Users: [{ Username: 'alice' }] }
      : { Groups: [{ GroupName: 'power' }, { GroupName: 'limit-test' }] }
  );

describe('getGroupsForUserSub', () => {
  it('resolves the username by sub, then lists its groups', async () => {
    respond();
    expect(await getGroupsForUserSub(SUB)).toEqual(['power', 'limit-test']);
    const [list, groups] = send.mock.calls.map(([c]) => c);
    expect(list.input).toEqual({
      UserPoolId: 'ap-northeast-1_pool',
      Filter: `sub = "${SUB}"`,
      Limit: 1,
    });
    expect(groups.input).toEqual({ UserPoolId: 'ap-northeast-1_pool', Username: 'alice' });
  });

  it('caches per user', async () => {
    respond();
    await getGroupsForUserSub(SUB);
    await getGroupsForUserSub(SUB);
    expect(send).toHaveBeenCalledTimes(2); // one ListUsers + one AdminListGroupsForUser
  });

  it('returns [] for an unknown sub', async () => {
    send.mockResolvedValue({ Users: [] });
    expect(await getGroupsForUserSub(SUB)).toEqual([]);
  });

  it('falls back to [] (base limits) when Cognito fails, without caching the failure', async () => {
    send.mockRejectedValueOnce(new Error('Throttling'));
    expect(await getGroupsForUserSub(SUB)).toEqual([]);
    respond();
    expect(await getGroupsForUserSub(SUB)).toEqual(['power', 'limit-test']);
  });
});
