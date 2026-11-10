/**
 * Moca Operations Dashboard
 *
 * CloudWatch dashboard providing operational visibility into all Moca resources.
 * Designed from automated operational monitoring insights across active service metrics.
 *
 * Widget layout (33 widgets total):
 *  Row 0: Header text (1 widget)
 *  Row 1: Executive KPIs — 6 SingleValue widgets
 *  Row 2: Lambda Core Functions — 6 metric widgets (2 visual rows of 3 each)
 *  Row 3: Backend API (Lambda Web Function + API CloudFront) — 4 metric widgets
 *  Row 4: DynamoDB — 6 metric widgets (2 visual rows of 3 each)
 *  Row 5: CloudFront & S3 — 4 metric widgets
 *  Row 6: Error Logs — 2 Log Insights widgets
 *  Row 6b: Backend API latency & cold starts — 2 Log Insights widgets
 *  Row 7: Cost Note text (1 widget)
 *  Row 8: Operational Insights text (1 widget)
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { BackendApi } from '../api/backend-api';

export interface OperationsDashboardProps {
  /** Dashboard name override (default: '{resourcePrefix}-operations') */
  readonly dashboardName?: string;
  /** Resource prefix used across the stack (e.g. 'moca') */
  readonly resourcePrefix: string;
  /** Stack name for display in the dashboard header */
  readonly stackName: string;
  /** Backend API (Lambda Web Function behind its own CloudFront distribution) */
  readonly backendApi: BackendApi;
  /** Session Stream Handler Lambda (DynamoDB Streams → AppSync Events) */
  readonly sessionStreamHandlerFunction: lambda.IFunction;
  /** Trigger Executor Lambda */
  readonly triggerExecutorFunction: lambda.IFunction;
  /** Gateway Interceptor Lambda (optional) */
  readonly gatewayInterceptorFunction?: lambda.IFunction;
  /** Agents DynamoDB table */
  readonly agentsTable: dynamodb.ITable;
  /** Sessions DynamoDB table */
  readonly sessionsTable: dynamodb.ITable;
  /** Triggers DynamoDB table */
  readonly triggersTable: dynamodb.ITable;
  /** CloudFront distribution for the frontend */
  readonly cloudFrontDistribution: cloudfront.IDistribution;
  /** User storage S3 bucket */
  readonly userStorageBucket: s3.IBucket;
}

/** CloudWatch Operations Dashboard for Moca */
export class OperationsDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: OperationsDashboardProps) {
    super(scope, id);

    const {
      resourcePrefix,
      stackName,
      backendApi,
      sessionStreamHandlerFunction,
      triggerExecutorFunction,
      gatewayInterceptorFunction,
      agentsTable,
      sessionsTable,
      triggersTable,
      cloudFrontDistribution,
      userStorageBucket,
    } = props;

    const region = cdk.Stack.of(this).region;
    const dashboardName = props.dashboardName ?? `${resourcePrefix}-operations-${region}`;

    // ── Helpers ──────────────────────────────────────────────────

    /** CloudFront metrics must target us-east-1 (global service). */
    const cfMetric = (
      metricName: string,
      stat: string,
      period?: cdk.Duration,
      distribution: cloudfront.IDistribution = cloudFrontDistribution,
      label?: string
    ) =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        dimensionsMap: { DistributionId: distribution.distributionId, Region: 'Global' },
        statistic: stat,
        period: period ?? cdk.Duration.hours(1),
        region: 'us-east-1',
        label,
      });

    /** Backend API Web Function metric (AWS/Lambda/Web, home Region). */
    const backendFunctionName = backendApi.webFunction.functionName;
    const webMetric = (
      metricName: string,
      stat: string,
      opts: { period?: cdk.Duration; label?: string; perEndpoint?: boolean } = {}
    ) =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda/Web',
        metricName,
        dimensionsMap: {
          FunctionName: backendFunctionName,
          ...(opts.perEndpoint === false ? {} : { EndpointName: backendApi.endpoint.endpointName }),
        },
        statistic: stat,
        period: opts.period ?? cdk.Duration.hours(1),
        label: opts.label,
      });
    const apiDistribution = backendApi.distribution;

    /** Raw DynamoDB metric with optional extra dimensions. */
    const ddbMetric = (
      tableName: string,
      metricName: string,
      stat: string,
      extra?: Record<string, string>,
      label?: string,
      period?: cdk.Duration
    ) =>
      new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName,
        dimensionsMap: { TableName: tableName, ...extra },
        statistic: stat,
        period: period ?? cdk.Duration.hours(1),
        label: label ?? `${tableName} ${metricName}`,
      });

    /** Lambda ConcurrentExecutions (not exposed on IFunction interface). */
    const lambdaConcurrent = (fn: lambda.IFunction) =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'ConcurrentExecutions',
        dimensionsMap: { FunctionName: fn.functionName },
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
        label: fn.functionName,
      });

    const activeFunctions: lambda.IFunction[] = [
      sessionStreamHandlerFunction,
      triggerExecutorFunction,
      ...(gatewayInterceptorFunction ? [gatewayInterceptorFunction] : []),
    ];

    // ── Row 0: Header ────────────────────────────────────────────
    const headerWidget = new cloudwatch.TextWidget({
      width: 24,
      height: 3,
      markdown: [
        `## 🖥️ Moca Operations Dashboard  —  Stack: \`${stackName}\``,
        '',
        '| Severity | Indicator | Meaning |',
        '|---|---|---|',
        '| 🔴 CRITICAL | Immediate action required | e.g. Any API 5xx, Lambda error rate > 1% |',
        '| 🟡 WARNING  | Investigate soon          | e.g. p99 latency > 8 s, DDB throttles > 0 |',
        '| 🟢 NORMAL   | Within baseline           | All metrics within expected ranges |',
      ].join('\n'),
    });

    // ── Row 1: Executive KPIs (4×4) ──────────────────────────────
    const kpiApiRequests = new cloudwatch.SingleValueWidget({
      title: 'API Requests (24 h)',
      width: 4,
      height: 4,
      sparkline: true,
      metrics: [webMetric('ExecutedRequests', 'Sum', { period: cdk.Duration.days(1) })],
    });

    const kpiLambdaErrors = new cloudwatch.SingleValueWidget({
      title: 'Lambda Errors (24 h)',
      width: 4,
      height: 4,
      sparkline: true,
      metrics: [
        sessionStreamHandlerFunction.metricErrors({
          statistic: 'Sum',
          period: cdk.Duration.days(1),
          label: 'SessionStream',
        }),
        triggerExecutorFunction.metricErrors({
          statistic: 'Sum',
          period: cdk.Duration.days(1),
          label: 'TriggerExecutor',
        }),
      ],
    });

    const kpiApi5xx = new cloudwatch.SingleValueWidget({
      title: '🔴 API 5xx Errors (24 h)',
      width: 4,
      height: 4,
      sparkline: true,
      metrics: [
        webMetric('HTTPResponseStatusClass5XX', 'Sum', {
          period: cdk.Duration.days(1),
          label: '5xx Errors',
        }),
      ],
    });

    const kpiApiCf5xx = new cloudwatch.SingleValueWidget({
      title: 'API CloudFront 5xx Rate (%)',
      width: 4,
      height: 4,
      sparkline: true,
      metrics: [
        cfMetric('5xxErrorRate', 'Average', cdk.Duration.days(1), apiDistribution, 'API 5xx %'),
      ],
    });

    const kpiCf5xx = new cloudwatch.SingleValueWidget({
      title: 'CloudFront 5xx Rate (%)',
      width: 4,
      height: 4,
      sparkline: true,
      metrics: [cfMetric('5xxErrorRate', 'Average', cdk.Duration.days(1))],
    });

    const kpiDdbThrottles = new cloudwatch.SingleValueWidget({
      title: 'DDB Throttles (24 h)',
      width: 4,
      height: 4,
      sparkline: true,
      metrics: [
        ddbMetric(
          agentsTable.tableName,
          'ThrottledRequests',
          'Sum',
          {},
          'agents',
          cdk.Duration.days(1)
        ),
        ddbMetric(
          sessionsTable.tableName,
          'ThrottledRequests',
          'Sum',
          {},
          'sessions',
          cdk.Duration.days(1)
        ),
        ddbMetric(
          triggersTable.tableName,
          'ThrottledRequests',
          'Sum',
          {},
          'triggers',
          cdk.Duration.days(1)
        ),
      ],
    });

    // ── Row 2a: Lambda invocations / duration / concurrency (8×6) ──
    const wLambdaInvocations = new cloudwatch.GraphWidget({
      title: 'Lambda Invocations (stacked)',
      width: 8,
      height: 6,
      left: activeFunctions.map((fn) =>
        fn.metricInvocations({ statistic: 'Sum', period: cdk.Duration.hours(1) })
      ),
      stacked: true,
    });

    const wLambdaDuration = new cloudwatch.GraphWidget({
      title: 'Lambda Duration — SessionStream (p50/p99)',
      width: 8,
      height: 6,
      left: [
        sessionStreamHandlerFunction.metricDuration({
          statistic: 'p50',
          period: cdk.Duration.hours(1),
          label: 'SessionStream p50',
        }),
        sessionStreamHandlerFunction.metricDuration({
          statistic: 'p99',
          period: cdk.Duration.hours(1),
          label: 'SessionStream p99',
        }),
      ],
    });

    const wLambdaConcurrent = new cloudwatch.GraphWidget({
      title: 'Concurrent Executions (peak)',
      width: 8,
      height: 6,
      left: activeFunctions.map((fn) => lambdaConcurrent(fn)),
    });

    // ── Row 2b: Lambda errors / throttles / trigger detail (8×6) ──
    const wLambdaErrors = new cloudwatch.GraphWidget({
      title: 'Lambda Errors',
      width: 8,
      height: 6,
      left: activeFunctions.map((fn) =>
        fn.metricErrors({ statistic: 'Sum', period: cdk.Duration.hours(1) })
      ),
      leftAnnotations: [{ label: '🟡 WARNING', value: 1, color: '#ff9900' }],
    });

    const wLambdaThrottles = new cloudwatch.GraphWidget({
      title: 'Lambda Throttles',
      width: 8,
      height: 6,
      left: activeFunctions.map((fn) =>
        fn.metricThrottles({ statistic: 'Sum', period: cdk.Duration.hours(1) })
      ),
      leftAnnotations: [{ label: '🟡 WARNING', value: 1, color: '#ff9900' }],
    });

    const wTriggerDetail = new cloudwatch.GraphWidget({
      title: 'Trigger Executor — Invocations & Avg Duration',
      width: 8,
      height: 6,
      left: [
        triggerExecutorFunction.metricInvocations({
          statistic: 'Sum',
          period: cdk.Duration.hours(1),
          label: 'Invocations',
        }),
      ],
      right: [
        triggerExecutorFunction.metricDuration({
          statistic: 'Average',
          period: cdk.Duration.hours(1),
          label: 'Avg Duration (ms)',
        }),
      ],
      rightAnnotations: [{ label: 'Baseline avg 2,629 ms', value: 2629, color: '#1f77b4' }],
    });

    // ── Row 3: Backend API — Web Function + API CloudFront (6×6) ──
    const wApiRequests = new cloudwatch.GraphWidget({
      title: 'API Requests (hourly)',
      width: 6,
      height: 6,
      left: [webMetric('ExecutedRequests', 'Sum', { label: 'Requests/hr' })],
      leftAnnotations: [{ label: 'Baseline ~16/hr', value: 16, color: '#1f77b4' }],
    });

    const wApiErrors = new cloudwatch.GraphWidget({
      title: '🔴 API 4xx / 5xx Responses',
      width: 6,
      height: 6,
      left: [
        webMetric('HTTPResponseStatusClass4XX', 'Sum', { label: '4xx' }),
        webMetric('HTTPResponseStatusClass5XX', 'Sum', { label: '5xx' }),
      ],
      leftAnnotations: [{ label: '🔴 CRITICAL — Any 5xx', value: 1, color: '#d62728' }],
    });

    const wApiLatency = new cloudwatch.GraphWidget({
      title: 'Web Function Environments — active time vs CPU time (ms)',
      width: 6,
      height: 6,
      left: [
        webMetric('EnvironmentActiveTime', 'Sum', {
          label: 'Active (billed memory)',
          perEndpoint: false,
        }),
        webMetric('EnvironmentCPUTime', 'Sum', { label: 'CPU (billed vCPU)', perEndpoint: false }),
      ],
    });

    const wApiIntegrationLatency = new cloudwatch.GraphWidget({
      title: 'Web Function Concurrency & Memory',
      width: 6,
      height: 6,
      left: [
        webMetric('EnvironmentConcurrentRequests', 'Maximum', {
          label: 'Max concurrent req / env',
          perEndpoint: false,
        }),
      ],
      right: [
        webMetric('EnvironmentMaxMemoryUsage', 'Maximum', {
          label: 'Max memory (MB)',
          perEndpoint: false,
        }),
      ],
    });

    // ── Row 4a: DynamoDB capacity (8×6) ──────────────────────────
    const wDdbRcu = new cloudwatch.GraphWidget({
      title: 'DynamoDB Read Capacity (RCU)',
      width: 8,
      height: 6,
      left: [
        ddbMetric(agentsTable.tableName, 'ConsumedReadCapacityUnits', 'Sum', {}, 'agents RCU'),
        ddbMetric(sessionsTable.tableName, 'ConsumedReadCapacityUnits', 'Sum', {}, 'sessions RCU'),
        ddbMetric(triggersTable.tableName, 'ConsumedReadCapacityUnits', 'Sum', {}, 'triggers RCU'),
      ],
    });

    const wDdbWcu = new cloudwatch.GraphWidget({
      title: 'DynamoDB Write Capacity (WCU)',
      width: 8,
      height: 6,
      left: [
        ddbMetric(agentsTable.tableName, 'ConsumedWriteCapacityUnits', 'Sum', {}, 'agents WCU'),
        ddbMetric(sessionsTable.tableName, 'ConsumedWriteCapacityUnits', 'Sum', {}, 'sessions WCU'),
        ddbMetric(triggersTable.tableName, 'ConsumedWriteCapacityUnits', 'Sum', {}, 'triggers WCU'),
      ],
    });

    const wDdbThrottles = new cloudwatch.GraphWidget({
      title: 'DynamoDB Throttles & System Errors',
      width: 8,
      height: 6,
      left: [
        ddbMetric(agentsTable.tableName, 'ThrottledRequests', 'Sum', {}, 'agents Throttles'),
        ddbMetric(sessionsTable.tableName, 'ThrottledRequests', 'Sum', {}, 'sessions Throttles'),
        ddbMetric(agentsTable.tableName, 'SystemErrors', 'Sum', {}, 'agents SystemErrors'),
        ddbMetric(sessionsTable.tableName, 'SystemErrors', 'Sum', {}, 'sessions SystemErrors'),
      ],
      leftAnnotations: [{ label: '🟡 WARNING', value: 1, color: '#ff9900' }],
    });

    // ── Row 4b: DynamoDB latency / account limits (8×6) ──────────
    const wDdbGetItemLatency = new cloudwatch.GraphWidget({
      title: 'DynamoDB GetItem Latency',
      width: 8,
      height: 6,
      left: [
        ddbMetric(
          agentsTable.tableName,
          'SuccessfulRequestLatency',
          'Average',
          { Operation: 'GetItem' },
          'agents GetItem avg'
        ),
        ddbMetric(
          sessionsTable.tableName,
          'SuccessfulRequestLatency',
          'Average',
          { Operation: 'GetItem' },
          'sessions GetItem avg'
        ),
      ],
    });

    const wDdbPutQueryLatency = new cloudwatch.GraphWidget({
      title: 'DynamoDB PutItem & Query Latency',
      width: 8,
      height: 6,
      left: [
        ddbMetric(
          sessionsTable.tableName,
          'SuccessfulRequestLatency',
          'Average',
          { Operation: 'PutItem' },
          'sessions PutItem avg'
        ),
        ddbMetric(
          agentsTable.tableName,
          'SuccessfulRequestLatency',
          'Average',
          { Operation: 'Query' },
          'agents Query avg'
        ),
        ddbMetric(
          sessionsTable.tableName,
          'SuccessfulRequestLatency',
          'Average',
          { Operation: 'Query' },
          'sessions Query avg'
        ),
      ],
    });

    const wDdbAccountLimits = new cloudwatch.GraphWidget({
      title: 'DynamoDB Account Table Limits (RCU / WCU utilization %)',
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'AccountProvisionedReadCapacityUtilization',
          statistic: 'Maximum',
          period: cdk.Duration.hours(1),
          label: 'Read utilization %',
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'AccountProvisionedWriteCapacityUtilization',
          statistic: 'Maximum',
          period: cdk.Duration.hours(1),
          label: 'Write utilization %',
        }),
      ],
    });

    // ── Row 5: CloudFront & S3 (6×6) ─────────────────────────────
    const wCfRequests = new cloudwatch.GraphWidget({
      title: 'CloudFront Requests (hourly)',
      width: 6,
      height: 6,
      left: [cfMetric('Requests', 'Sum')],
    });

    const wCfErrors = new cloudwatch.GraphWidget({
      title: '🔴 CloudFront Error Rates',
      width: 6,
      height: 6,
      left: [
        cfMetric('5xxErrorRate', 'Average'),
        cfMetric('4xxErrorRate', 'Average'),
        cfMetric('TotalErrorRate', 'Average'),
      ],
      leftAnnotations: [
        { label: '🔴 CRITICAL 5xx > 1%', value: 1, color: '#d62728' },
        { label: '🟡 WARNING 5xx > 0.5%', value: 0.5, color: '#ff9900' },
      ],
    });

    const wCfDataTransfer = new cloudwatch.GraphWidget({
      title: 'CloudFront Data Transfer',
      width: 6,
      height: 6,
      left: [cfMetric('BytesDownloaded', 'Sum'), cfMetric('BytesUploaded', 'Sum')],
    });

    const wS3Storage = new cloudwatch.GraphWidget({
      title: 'S3 User Storage Size (bytes)',
      width: 6,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/S3',
          metricName: 'BucketSizeBytes',
          dimensionsMap: {
            BucketName: userStorageBucket.bucketName,
            StorageType: 'StandardStorage',
          },
          statistic: 'Average',
          period: cdk.Duration.days(1),
          label: 'StandardStorage',
        }),
      ],
      leftAnnotations: [
        { label: 'Baseline ~9.2 GB', value: 9.2 * 1024 * 1024 * 1024, color: '#1f77b4' },
      ],
    });

    // ── Row 6b: Backend API latency & cold starts (12×6) ─────────
    // Web Functions publish no latency metric, and CloudFront OriginLatency
    // needs paid additional metrics; the app's access log already records
    // per-request `responseTime`, so percentiles come from Logs Insights.
    const wBackendLatency = new cloudwatch.LogQueryWidget({
      title: 'Backend API Latency (ms, from access log responseTime)',
      width: 12,
      height: 6,
      logGroupNames: [backendApi.logGroup.logGroupName],
      queryLines: [
        'filter msg = "request completed" and req.method != "OPTIONS"',
        'stats pct(responseTime, 50) as p50, pct(responseTime, 99) as p99, count(*) as requests by bin(1h)',
      ],
      view: cloudwatch.LogQueryVisualizationType.LINE,
    });

    const wBackendColdStarts = new cloudwatch.LogQueryWidget({
      title: 'Backend Web Function Cold Starts (count / avg init ms)',
      width: 12,
      height: 6,
      logGroupNames: [backendApi.logGroup.logGroupName],
      queryLines: [
        'filter type = "platform.initReport"',
        'stats count(*) as coldStarts, avg(record.metrics.totalDurationMs) as avgInitMs by bin(1h)',
      ],
      view: cloudwatch.LogQueryVisualizationType.LINE,
    });

    // ── Row 6: Error Log Insights (12×6) ─────────────────────────
    const wBackendApiLogs = new cloudwatch.LogQueryWidget({
      title: 'BackendAPI — Error / Exception / WARN Logs',
      width: 12,
      height: 6,
      logGroupNames: [backendApi.logGroup.logGroupName],
      queryLines: [
        'fields @timestamp, @message, @logStream',
        'filter @message like /(?i)(error|exception|warn)/',
        'sort @timestamp desc',
        'limit 50',
      ],
      view: cloudwatch.LogQueryVisualizationType.TABLE,
    });

    const wSessionStreamLogs = new cloudwatch.LogQueryWidget({
      title: 'SessionStreamHandler — Error / Exception / WARN Logs',
      width: 12,
      height: 6,
      logGroupNames: [`/aws/lambda/${sessionStreamHandlerFunction.functionName}`],
      queryLines: [
        'fields @timestamp, @message, @logStream',
        'filter @message like /(?i)(error|exception|warn)/',
        'sort @timestamp desc',
        'limit 50',
      ],
      view: cloudwatch.LogQueryVisualizationType.TABLE,
    });

    // ── Row 7: Cost Note ─────────────────────────────────────────
    const wCostNote = new cloudwatch.TextWidget({
      width: 24,
      height: 4,
      markdown: [
        '## 💰 Cost Monitoring',
        '',
        'CloudWatch does not display AWS cost data directly. Use **[AWS Cost Explorer](https://console.aws.amazon.com/cost-management/home#/cost-explorer)** for detailed billing analysis.',
        '',
        '| Note | Detail |',
        '|---|---|',
        '| Primary cost driver | **Amazon Bedrock** accounts for ~90–95% of Moca monthly cost |',
        '| Data freshness | Cost Explorer data may lag 2–3 days at month-end |',
        '| Alert thresholds | 🔴 CRITICAL > $200/day · 🟡 WARNING > $150/day · 🟢 Baseline ~$140/day |',
      ].join('\n'),
    });

    // ── Row 8: Operational Insights ──────────────────────────────
    const wOperationalInsights = new cloudwatch.TextWidget({
      width: 24,
      height: 10,
      markdown: [
        '## 📊 Operational Baseline & Alert Thresholds',
        '',
        '### Key Metric Baselines (mean ± σ from operational monitoring)',
        '',
        '| Metric | Baseline (mean) | Std Dev | Notes |',
        '|---|---|---|---|',
        '| API Requests/day | ~431 avg / 1,824 peak | ±199 | Weekday peak; weekend ~40% lower. Peak record 4/3 |',
        '| API avg Latency | ~616 ms | ±180 ms | Measured on the former API Gateway; now see Backend API Latency (access-log responseTime) |',
        '| API p99 Latency | ~3,935 ms | — | Bedrock inference dominates tail |',
        '| Trigger Executor avg Duration | ~2,629 ms | ±400 ms | 2–3 executions/day |',
        '| DDB agents RCU/day | ~2,990 | ±1,491 | Primary read table |',
        '| DDB sessions WCU/day | ~632 | ±279 | Primary write table; trending toward ~1,390 on peak days |',
        '| CF 5xx Error Rate | 0% | — | 25+ days continuous zero |',
        '| API 5xx Errors | 0 | — | 25+ days continuous zero |',
        '',
        '### Weekly Traffic Pattern',
        '',
        '| Day | Relative Traffic | Notes |',
        '|---|---|---|',
        '| Monday – Friday | 100% (baseline) | Business hours peak 09:00–18:00 JST |',
        '| Saturday – Sunday | ~40% | Light usage |',
        '',
        '### Alert Threshold Reference',
        '',
        '| Metric | 🔴 CRITICAL | 🟡 WARNING | 🟢 Normal Baseline |',
        '|---|---|---|---|',
        '| Lambda Error Rate | > 1% | > 0.1% | 0% |',
        '| API 5xx Errors | Any > 0 | — | 0 |',
        '| API p99 Latency | — | > 8,000 ms | ~3,935 ms |',
        '| CF 5xx Rate | > 1% | > 0.5% | 0% |',
        '| DDB Throttles | — | Any > 0 | 0 |',
        '| Daily Cost | > $200 | > $150 | ~$140 |',
      ].join('\n'),
    });

    // ── Assemble Dashboard ────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName,
      defaultInterval: cdk.Duration.hours(24),
    });

    this.dashboard.addWidgets(headerWidget); // Row 0
    this.dashboard.addWidgets(
      kpiApiRequests,
      kpiLambdaErrors,
      kpiApi5xx,
      kpiApiCf5xx,
      kpiCf5xx,
      kpiDdbThrottles
    ); // Row 1
    this.dashboard.addWidgets(wLambdaInvocations, wLambdaDuration, wLambdaConcurrent); // Row 2a
    this.dashboard.addWidgets(wLambdaErrors, wLambdaThrottles, wTriggerDetail); // Row 2b
    this.dashboard.addWidgets(wApiRequests, wApiErrors, wApiLatency, wApiIntegrationLatency); // Row 3
    this.dashboard.addWidgets(wDdbRcu, wDdbWcu, wDdbThrottles); // Row 4a
    this.dashboard.addWidgets(wDdbGetItemLatency, wDdbPutQueryLatency, wDdbAccountLimits); // Row 4b
    this.dashboard.addWidgets(wCfRequests, wCfErrors, wCfDataTransfer, wS3Storage); // Row 5
    this.dashboard.addWidgets(wBackendApiLogs, wSessionStreamLogs); // Row 6
    this.dashboard.addWidgets(wBackendLatency, wBackendColdStarts); // Row 6b
    this.dashboard.addWidgets(wCostNote); // Row 7
    this.dashboard.addWidgets(wOperationalInsights); // Row 8

    cdk.Tags.of(this.dashboard).add('Project', 'AgentCore');
    cdk.Tags.of(this.dashboard).add('Component', 'Monitoring');
  }
}
