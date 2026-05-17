import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface WafStackProps extends cdk.StackProps {
  /**
   * Resource name prefix for the WAF WebACL
   */
  readonly resourcePrefix: string;
}

/**
 * WAF Stack for CloudFront WebACL
 *
 * Must be deployed in us-east-1 because CloudFront WAF WebACLs require
 * scope=CLOUDFRONT which is only available in the us-east-1 region.
 * The WebACL ARN is passed cross-region to AgentCoreStack via CDK
 * crossRegionReferences.
 */
export class WafStack extends cdk.Stack {
  /**
   * WAF WebACL ARN to be attached to CloudFront distribution
   */
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, {
      ...props,
      // CloudFront WAF must be in us-east-1
      env: {
        account: props.env?.account,
        region: 'us-east-1',
      },
    });

    const { resourcePrefix } = props;

    // WAF WebACL with AWS managed rule groups (CFR2)
    const webAcl = new wafv2.CfnWebACL(this, 'CloudFrontWebAcl', {
      name: `${resourcePrefix}-cloudfront-waf`,
      // CLOUDFRONT scope is only valid in us-east-1
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${resourcePrefix}-cloudfront-waf`,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
          },
        },
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesAmazonIpReputationList',
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;

    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAclArn,
      description: 'WAF WebACL ARN for CloudFront distribution',
    });

    // cdk-nag suppressions for WafStack
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole is the standard managed policy for Lambda functions to write CloudWatch Logs.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Lambda runtime versions are managed by CDK internal Custom Resources which are not directly controllable.',
      },
    ]);
  }
}
