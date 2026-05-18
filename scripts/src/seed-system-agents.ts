#!/usr/bin/env node
/**
 * Seed system default agents into DynamoDB.
 *
 * Usage:
 *   npm run seed-system-agents -- --env default
 *   npm run seed-system-agents -- --env dev
 *   npm run seed-system-agents -- --env prd --force
 *   npm run seed-system-agents -- --env dev --table mocadev-agents
 *
 * Options:
 *   --env      Environment name (default|dev|stg|prd)     [default: default]
 *   --region   AWS region (default: from AWS_REGION / AWS_DEFAULT_REGION / AWS profile)
 *   --table    DynamoDB table name (auto-detected from CloudFormation if omitted)
 *   --force    Delete existing system agents and re-seed
 *   --dry-run  Show what would be done without making changes
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import { SYSTEM_USER_ID } from '../../packages/libs/core/src/system-ids.js';
import { DEFAULT_AGENTS } from '../../packages/backend/src/config/data/default-agents.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const VALID_ENVS = ['default', 'dev', 'stg', 'prd'] as const;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      opts.env = args[++i];
    } else if (args[i] === '--region' && args[i + 1]) {
      opts.region = args[++i];
    } else if (args[i] === '--table' && args[i + 1]) {
      opts.table = args[++i];
    } else if (args[i] === '--force') {
      opts.force = true;
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npm run seed-system-agents -- --env <default|dev|stg|prd> [options]

Options:
  --env      Environment name (default|dev|stg|prd)     [default: default]
  --region   AWS region (default: from AWS_REGION / AWS_DEFAULT_REGION / AWS profile)
  --table    DynamoDB table name (auto-detected from CloudFormation if omitted)
  --force    Delete existing system agents and re-seed
  --dry-run  Show what would be done without making changes
`);
      process.exit(0);
    }
  }

  if (!opts.env) {
    opts.env = 'default';
  }

  if (!VALID_ENVS.includes(opts.env as (typeof VALID_ENVS)[number])) {
    console.error(`❌ --env must be one of: ${VALID_ENVS.join(', ')}. Got: "${opts.env}"`);
    process.exit(1);
  }

  return {
    env: opts.env as string,
    region: opts.region as string | undefined,
    table: opts.table as string | undefined,
    force: !!opts.force,
    dryRun: !!opts.dryRun,
  };
}

// ---------------------------------------------------------------------------
// CloudFormation helpers
// ---------------------------------------------------------------------------

async function getStackOutputs(
  stackName: string,
  region: string | undefined
): Promise<Record<string, string>> {
  const client = new CloudFormationClient(region ? { region } : {});
  const res = await client.send(
    new DescribeStacksCommand({ StackName: stackName })
  );

  const stack = res.Stacks?.[0];
  if (!stack) {
    throw new Error(`Stack "${stackName}" not found`);
  }

  const outputs: Record<string, string> = {};
  for (const o of stack.Outputs || []) {
    if (o.OutputKey && o.OutputValue) {
      outputs[o.OutputKey] = o.OutputValue;
    }
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

async function listSystemAgents(
  client: DynamoDBClient,
  tableName: string
): Promise<Array<{ userId: string; agentId: string; name: string }>> {
  const res = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: marshall({ ':uid': SYSTEM_USER_ID }),
    })
  );

  return (res.Items || []).map((item) => {
    const r = unmarshall(item);
    return { userId: r.userId, agentId: r.agentId, name: r.name };
  });
}

async function deleteSystemAgents(
  client: DynamoDBClient,
  tableName: string,
  agents: Array<{ userId: string; agentId: string }>
): Promise<void> {
  for (const agent of agents) {
    await client.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ userId: agent.userId, agentId: agent.agentId }),
      })
    );
  }
}

interface CreateAgentInput {
  name: string;
  description: string;
  icon?: string;
  systemPrompt: string;
  enabledTools: string[];
  scenarios: Array<{ title: string; prompt: string }>;
  mcpConfig?: unknown;
}

async function createAgent(
  client: DynamoDBClient,
  tableName: string,
  input: CreateAgentInput
): Promise<{ agentId: string; name: string }> {
  const now = new Date().toISOString();
  const agentId = uuidv7();

  const item = {
    userId: SYSTEM_USER_ID,
    agentId,
    name: input.name,
    description: input.description,
    icon: input.icon,
    systemPrompt: input.systemPrompt,
    enabledTools: input.enabledTools,
    scenarios: input.scenarios.map((s) => ({
      ...s,
      id: uuidv7(),
    })),
    mcpConfig: input.mcpConfig,
    createdAt: now,
    updatedAt: now,
    isShared: 'true', // String — matches DynamoAgent GSI key format (agents-service.ts:toDynamoAgent)
    createdBy: 'System',
  };

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(item, { removeUndefinedValues: true }),
    })
  );

  return { agentId, name: input.name };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  // default environment has no suffix (stack: MocaAgentCoreApp), others capitalize first letter
  const stackName =
    opts.env === 'default'
      ? 'MocaAgentCoreApp'
      : `MocaAgentCoreApp${opts.env.charAt(0).toUpperCase() + opts.env.slice(1)}`;

  const displayRegion =
    opts.region ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    '(from AWS config/profile)';
  console.log(
    `\n🔍 Environment: ${opts.env} (stack: ${stackName}, region: ${displayRegion})`
  );
  if (opts.dryRun) console.log('📋 DRY RUN — no changes will be made\n');

  // 1. Resolve table name (from --table flag or CloudFormation outputs)
  let tableName: string;
  if (opts.table) {
    tableName = opts.table;
  } else {
    const outputs = await getStackOutputs(stackName, opts.region);
    tableName = outputs.AgentsTableName;
    if (!tableName) {
      throw new Error('AgentsTableName not found in stack outputs');
    }
  }
  console.log(`📦 Agents table: ${tableName}`);

  // 2. (DEFAULT_AGENTS loaded via static import at top of file)
  console.log(`📝 Default agents defined: ${DEFAULT_AGENTS.length}`);

  // 3. Check existing system agents
  const dynamoClient = new DynamoDBClient(opts.region ? { region: opts.region } : {});
  const existing = await listSystemAgents(dynamoClient, tableName);
  console.log(`📊 Existing system agents in DynamoDB: ${existing.length}`);

  if (existing.length > 0) {
    for (const a of existing) {
      console.log(`   - ${a.agentId}  ${a.name}`);
    }
  }

  // 4. Handle existing agents
  if (existing.length > 0 && !opts.force) {
    console.log(
      `\nℹ️  System agents already exist. Use --force to delete and re-seed.`
    );
    process.exit(0);
  }

  if (existing.length > 0 && opts.force) {
    console.log(`\n🗑️  Deleting ${existing.length} existing system agents...`);
    if (!opts.dryRun) {
      await deleteSystemAgents(dynamoClient, tableName, existing);
    }
    console.log('   Done.');
  }

  // 5. Seed — track progress for partial failure reporting
  console.log(`\n🌱 Seeding ${DEFAULT_AGENTS.length} system agents...`);
  const created: Array<{ agentId: string; name: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const input of DEFAULT_AGENTS) {
    if (opts.dryRun) {
      console.log(`   [dry-run] Would create: ${input.name}`);
      continue;
    }
    try {
      const agent = await createAgent(dynamoClient, tableName, input);
      created.push(agent);
      console.log(`   ✅ ${agent.agentId}  ${agent.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ name: input.name, error: msg });
      console.error(`   ❌ Failed: ${input.name} — ${msg}`);
    }
  }

  // 6. Summary
  if (opts.dryRun) {
    console.log(
      `\n📋 Would seed ${DEFAULT_AGENTS.length} system agents (userId: ${SYSTEM_USER_ID})\n`
    );
  } else if (failed.length === 0) {
    console.log(`\n✨ Seeded ${created.length} system agents (userId: ${SYSTEM_USER_ID})\n`);
  } else {
    console.error(`\n⚠️  Partial seed: ${created.length} succeeded, ${failed.length} failed`);
    for (const f of failed) {
      console.error(`   - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', err);
  process.exit(1);
});