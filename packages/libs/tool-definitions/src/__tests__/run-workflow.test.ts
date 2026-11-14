import {
  runWorkflowDefinition,
  validateWorkflowSpec,
  workflowSpecSchema,
  type WorkflowSpec,
} from '../definitions/run-workflow';

const spec = (steps: WorkflowSpec['steps']): WorkflowSpec => ({ goal: 'g', steps });

describe('validateWorkflowSpec', () => {
  it('accepts a DAG', () => {
    expect(
      validateWorkflowSpec(
        spec([
          { id: 'a', agentId: 'x', prompt: 'p' },
          { id: 'b', agentId: 'x', prompt: 'p', dependsOn: ['a'] },
          { id: 'c', agentId: 'x', prompt: 'p', dependsOn: ['a', 'b'] },
        ])
      )
    ).toEqual([]);
  });

  it('rejects duplicate ids and unknown dependencies', () => {
    const problems = validateWorkflowSpec(
      spec([
        { id: 'a', agentId: 'x', prompt: 'p' },
        { id: 'a', agentId: 'x', prompt: 'p', dependsOn: ['missing'] },
      ])
    );
    expect(problems).toEqual([
      'Duplicate step id "a"',
      'Step "a" depends on unknown step "missing"',
    ]);
  });

  it('rejects a spec too large for the workflow record', () => {
    // 10 prompts of 20k Japanese chars ≈ 600 KB — passes zod, overflows DynamoDB.
    const prompt = 'あ'.repeat(20_000);
    const steps = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, agentId: 'x', prompt }));
    expect(validateWorkflowSpec(spec(steps))[0]).toMatch(/too large/);
  });

  it('rejects cycles', () => {
    const problems = validateWorkflowSpec(
      spec([
        { id: 'a', agentId: 'x', prompt: 'p', dependsOn: ['b'] },
        { id: 'b', agentId: 'x', prompt: 'p', dependsOn: ['a'] },
        { id: 'c', agentId: 'x', prompt: 'p' },
      ])
    );
    expect(problems).toEqual(['Dependency cycle among steps: a, b']);
  });
});

describe('workflowSpecSchema', () => {
  it('enforces step id shape and limits', () => {
    expect(
      workflowSpecSchema.safeParse(spec([{ id: 'Bad-Id', agentId: 'x', prompt: 'p' }])).success
    ).toBe(false);
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      id: `s${i}`,
      agentId: 'x',
      prompt: 'p',
    }));
    expect(workflowSpecSchema.safeParse(spec(tooMany)).success).toBe(false);
    expect(
      workflowSpecSchema.safeParse(
        spec([
          {
            id: 'a',
            agentId: 'x',
            prompt: 'p',
            review: { agentId: 'r', criteria: 'c', maxIterations: 4 },
          },
        ])
      ).success
    ).toBe(false);
  });
});

describe('runWorkflowDefinition', () => {
  it('exposes the action enum in its JSON schema', () => {
    expect(runWorkflowDefinition.name).toBe('run_workflow');
    expect(runWorkflowDefinition.jsonSchema.required).toContain('action');
  });

  it('rejects an unknown modelId when the known ids are given, listing them', () => {
    const problems = validateWorkflowSpec(
      spec([
        { id: 'a', agentId: 'x', prompt: 'p', modelId: 'nope' },
        { id: 'b', agentId: 'x', prompt: 'p', modelId: 'm1' },
        { id: 'c', agentId: 'x', prompt: 'p', review: { agentId: 'r', criteria: 'c', modelId: 'bad' } },
      ]),
      { knownModelIds: ['m1', 'm2'] }
    );
    expect(problems).toEqual([
      'Step "a": unknown modelId "nope". Use one of: m1, m2 (or omit it for the agent\'s default)',
      'Step "c" review: unknown modelId "bad". Use one of: m1, m2 (or omit it for the agent\'s default)',
    ]);
  });
});
