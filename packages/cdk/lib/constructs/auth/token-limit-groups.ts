import { createHash } from 'node:crypto';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface TokenLimitGroupsProps {
  readonly userPoolId: string;
  /** Group names from `tokenLimits.groups` in environments.ts. */
  readonly groupNames: readonly string[];
}

/**
 * Construct id for a group. A hash, not a sanitized name: 'limit-test' and
 * 'limittest', or two non-ASCII names, would sanitize to the same id and fail
 * synth. Stable per name (unlike an index), so reordering the config does not
 * replace — and empty — existing groups.
 */
export function tokenLimitGroupId(groupName: string): string {
  return `Group${createHash('sha256').update(groupName).digest('hex').slice(0, 12)}`;
}

/** One Cognito User Pool group per `tokenLimits.groups` key. Members are assigned by admins. */
export class TokenLimitGroups extends Construct {
  constructor(scope: Construct, id: string, props: TokenLimitGroupsProps) {
    super(scope, id);
    for (const groupName of props.groupNames) {
      new cognito.CfnUserPoolGroup(this, tokenLimitGroupId(groupName), {
        userPoolId: props.userPoolId,
        groupName,
        description: 'Monthly token limit group (environments.ts tokenLimits.groups)',
      });
    }
  }
}
