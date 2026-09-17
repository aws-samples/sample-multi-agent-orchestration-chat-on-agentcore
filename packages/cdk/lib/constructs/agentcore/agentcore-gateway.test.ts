import { describe, expect, it } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as path from 'node:path';
import { AgentCoreGateway } from './agentcore-gateway';

const props = {
  gatewayName: 'test-gateway',
  authType: 'jwt' as const,
  jwtConfig: {
    discoveryUrl: 'https://example.invalid/.well-known/openid-configuration',
    allowedClients: ['frontend-client', 'machine-client'],
  },
  enableInterceptor: true,
  identityPoolId: 'us-east-1:00000000-0000-0000-0000-000000000000',
  userPoolId: 'us-east-1_testpool',
  userPoolClientId: 'frontend-client',
  machineUserClientId: 'machine-client',
};

function stack(name: string) {
  return new Stack(new App({ outdir: path.join(process.cwd(), 'cdk.out', name) }), name);
}

describe('Gateway interceptor verification configuration', () => {
  it('bundles the verifier and supplies explicit client allow-lists', () => {
    const scope = stack('GatewayAuthTest');
    new AgentCoreGateway(scope, 'Gateway', props);
    Template.fromStack(scope).hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          IDENTITY_POOL_ID: props.identityPoolId,
          COGNITO_USER_POOL_ID: props.userPoolId,
          COGNITO_USER_POOL_CLIENT_ID: props.userPoolClientId,
          COGNITO_MACHINE_USER_CLIENT_ID: props.machineUserClientId,
        },
      },
    });
  });

  it('rejects an enabled interceptor without a frontend client', () => {
    expect(
      () =>
        new AgentCoreGateway(stack('MissingGatewayClient'), 'Gateway', {
          ...props,
          userPoolClientId: undefined,
        })
    ).toThrow('userPoolClientId');
  });
});
