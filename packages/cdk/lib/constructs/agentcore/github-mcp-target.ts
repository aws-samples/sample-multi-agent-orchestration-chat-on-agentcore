import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Gateway target name. Tools are exposed as `github___{toolName}`. Shared with
 * the agent / interceptor via USER_DELEGATED_GATEWAY_TARGETS.
 */
export const GITHUB_MCP_TARGET_NAME = 'github';

export interface GithubMcpTargetProps {
  readonly gateway: agentcore.IGateway;
  /** Gateway ID — also the name of the workload identity the Gateway uses. */
  readonly gatewayId: string;
  readonly resourcePrefix: string;
  /** GitHub App Client ID */
  readonly clientId: string;
  /** Secrets Manager secret name holding `{"clientSecret": "..."}` */
  readonly clientSecretName: string;
  /** Frontend page that receives `?session_id=` after the user consents */
  readonly returnUrl: string;
}

/**
 * GitHub MCP server behind the Gateway with Authorization Code (3LO) outbound
 * auth: each user consents with their own GitHub account and the token stays
 * in the AgentCore Identity Token Vault (never in the agent container).
 *
 * See docs/adr/gateway-3lo-github.md.
 */
export class GithubMcpTarget extends Construct {
  public readonly target: agentcore.GatewayTarget;
  public readonly provider: agentcore.OAuth2CredentialProvider;

  constructor(scope: Construct, id: string, props: GithubMcpTargetProps) {
    super(scope, id);

    this.provider = agentcore.OAuth2CredentialProvider.usingGithub(this, 'Provider', {
      oAuth2CredentialProviderName: `${props.resourcePrefix}-${GITHUB_MCP_TARGET_NAME}`,
      clientId: props.clientId,
      clientSecret: cdk.SecretValue.secretsManager(props.clientSecretName, {
        jsonField: 'clientSecret',
      }),
    });

    this.target = agentcore.GatewayTarget.forMcpServer(this, 'Target', {
      gateway: props.gateway,
      gatewayTargetName: GITHUB_MCP_TARGET_NAME,
      description: 'GitHub MCP server (read-only) with per-user OAuth (Authorization Code)',
      // `/readonly` makes GitHub refuse write tools server-side, independent of
      // the static schema below.
      endpoint: 'https://api.githubcopilot.com/mcp/readonly',
      credentialProviderConfigurations: [
        // GitHub App permissions are configured on the App itself; scopes are unused.
        agentcore.GatewayCredentialProvider.fromOauthIdentity(this.provider, { scopes: [] }),
      ],
    });

    // aws-cdk-lib's L2 exposes neither grantType/defaultReturnUrl nor mcpToolSchema.
    const cfnTarget = this.target.node.defaultChild as agentcore.CfnGatewayTarget;
    const oauthPath =
      'CredentialProviderConfigurations.0.CredentialProvider.OauthCredentialProvider';
    cfnTarget.addPropertyOverride(`${oauthPath}.GrantType`, 'AUTHORIZATION_CODE');
    cfnTarget.addPropertyOverride(`${oauthPath}.DefaultReturnUrl`, props.returnUrl);
    // A static schema avoids implicit sync, which would block the deployment on an
    // admin OAuth consent (CREATE_PENDING_AUTH) and expose all GitHub tools.
    cfnTarget.addPropertyOverride(
      'TargetConfiguration.Mcp.McpServer.McpToolSchema.InlinePayload',
      fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'schemas', 'github-mcp-tools.json'),
        'utf8'
      )
    );

    // An empty allow-list disables return URL validation entirely, so pin it to
    // the frontend callback. There is no CloudFormation property for the
    // Gateway-managed workload identity.
    const workloadIdentityArn = cdk.Stack.of(this).formatArn({
      service: 'bedrock-agentcore',
      resource: 'workload-identity-directory',
      resourceName: `default/workload-identity/${props.gatewayId}`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const updateWorkloadIdentity: cr.AwsSdkCall = {
      service: 'bedrock-agentcore-control',
      action: 'UpdateWorkloadIdentity',
      parameters: {
        name: props.gatewayId,
        allowedResourceOauth2ReturnUrls: [props.returnUrl],
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${props.gatewayId}-return-urls`),
    };
    new cr.AwsCustomResource(this, 'ReturnUrlAllowList', {
      onCreate: updateWorkloadIdentity,
      onUpdate: updateWorkloadIdentity,
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:UpdateWorkloadIdentity'],
          resources: [
            workloadIdentityArn,
            cdk.Stack.of(this).formatArn({
              service: 'bedrock-agentcore',
              resource: 'workload-identity-directory',
              resourceName: 'default',
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ],
        }),
      ]),
    });
  }
}
