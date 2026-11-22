import { describe, expect, it } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { TokenLimitGroups, tokenLimitGroupId } from './token-limit-groups';

const synth = (groupNames: string[]) => {
  const stack = new cdk.Stack(new cdk.App(), 'Test');
  new TokenLimitGroups(stack, 'Groups', { userPoolId: 'pool', groupNames });
  return Template.fromStack(stack);
};

describe('TokenLimitGroups', () => {
  it('creates one group per name, including names that sanitize alike or are non-ASCII', () => {
    const template = synth(['limit-test', 'limittest', '営業', '開発']);
    const names = Object.values(template.findResources('AWS::Cognito::UserPoolGroup')).map(
      (r) => r.Properties.GroupName
    );
    expect(names.sort()).toEqual(['limit-test', 'limittest', '営業', '開発'].sort());
  });

  it('keeps a group id stable regardless of order', () => {
    expect(tokenLimitGroupId('power')).toBe(tokenLimitGroupId('power'));
    const a = Object.keys(synth(['a', 'b']).findResources('AWS::Cognito::UserPoolGroup')).sort();
    const b = Object.keys(synth(['b', 'a']).findResources('AWS::Cognito::UserPoolGroup')).sort();
    expect(a).toEqual(b);
  });
});
