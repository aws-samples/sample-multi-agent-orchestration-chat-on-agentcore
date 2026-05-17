import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { EventRuleConfig } from '../../../config';

export interface TriggerEventSourcesProps {
  /**
   * Resource name prefix
   */
  readonly resourcePrefix: string;

  /**
   * Event rules configuration
   */
  readonly eventRules: EventRuleConfig[];

  /**
   * Trigger Lambda function to invoke
   */
  readonly triggerLambda: lambda.IFunction;
}

/**
 * Trigger Event Sources Construct
 *
 * Creates EventBridge Rules that trigger Lambda when events match patterns.
 * Does NOT create event sources (S3, GitHub, etc.) - those should exist externally.
 *
 * This construct only creates:
 * - EventBridge Rules with specified event patterns
 * - Lambda targets for those rules
 * - Configuration export for frontend display
 */
export class TriggerEventSources extends Construct {
  /**
   * EventBridge rules created for each event source
   */
  public readonly eventRules: events.Rule[] = [];

  /**
   * Event source mapping (eventSourceId -> Rule ARN)
   */
  public readonly eventSourceMapping: Map<string, string> = new Map();

  /**
   * Event sources configuration (for frontend display)
   * JSON string containing event source metadata
   */
  public readonly eventSourcesConfig: string;

  constructor(scope: Construct, id: string, props: TriggerEventSourcesProps) {
    super(scope, id);

    // Create EventBridge Rules for each event rule config
    for (const ruleConfig of props.eventRules) {
      if (!ruleConfig.enabled) continue;

      // Convert event pattern to CDK EventPattern
      const eventPattern: events.EventPattern = {
        source: ruleConfig.eventPattern.source,
        detailType: ruleConfig.eventPattern.detailType,
        ...(ruleConfig.eventPattern.detail && { detail: ruleConfig.eventPattern.detail }),
      };

      // Create EventBridge Rule
      const rule = new events.Rule(this, `Rule-${ruleConfig.id}`, {
        ruleName: `${props.resourcePrefix}-trigger-${ruleConfig.id}`,
        description: `${ruleConfig.name}: ${ruleConfig.description}`,
        eventPattern,
        enabled: true,
      });

      // Add Lambda as target with InputTransformer to inject eventSourceId
      rule.addTarget(
        new targets.LambdaFunction(props.triggerLambda, {
          retryAttempts: 2,
          maxEventAge: cdk.Duration.hours(1),
          event: events.RuleTargetInput.fromObject({
            // Preserve all original event fields
            version: events.EventField.fromPath('$.version'),
            id: events.EventField.fromPath('$.id'),
            'detail-type': events.EventField.fromPath('$.detail-type'),
            source: events.EventField.fromPath('$.source'),
            account: events.EventField.fromPath('$.account'),
            time: events.EventField.fromPath('$.time'),
            region: events.EventField.fromPath('$.region'),
            resources: events.EventField.fromPath('$.resources'),
            detail: events.EventField.fromPath('$.detail'),
            // Inject eventSourceId for easy identification in Lambda
            _eventSourceId: ruleConfig.id,
          }),
        })
      );

      this.eventRules.push(rule);
      this.eventSourceMapping.set(ruleConfig.id, rule.ruleArn);

      // Add tags
      cdk.Tags.of(rule).add('EventSourceId', ruleConfig.id);
    }

    // Export event source metadata for frontend (include eventPattern for detailed display)
    const frontendConfig = props.eventRules
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        icon: r.icon,
        eventPattern: r.eventPattern,
      }));

    this.eventSourcesConfig = JSON.stringify(frontendConfig);

    // Output event source configuration
    if (frontendConfig.length > 0) {
      new cdk.CfnOutput(this, 'EventSourcesConfig', {
        value: this.eventSourcesConfig,
        description: 'Event sources configuration (for frontend display)',
      });
    }

    // Output event source mappings
    if (this.eventSourceMapping.size > 0) {
      const mappingJson = JSON.stringify(Object.fromEntries(this.eventSourceMapping));
      new cdk.CfnOutput(this, 'EventSourceMapping', {
        value: mappingJson,
        description: 'Event source ID to Rule ARN mapping',
      });
    }
  }
}
