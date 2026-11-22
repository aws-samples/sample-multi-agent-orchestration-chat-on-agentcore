import { describe, it, expect, vi } from 'vitest';
import { backendClient } from '../client/backend-client';
import { getMyUsage } from '../usage';

vi.mock('../client/backend-client', () => ({ backendClient: { get: vi.fn() } }));

describe('getMyUsage', () => {
  it('unwraps the envelope and normalizes model ids to metering keys', async () => {
    vi.mocked(backendClient.get).mockResolvedValue({
      enabled: true,
      period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '2026-11-30T15:00:00Z' },
      groups: ['power'],
      models: [
        {
          modelKey: 'anthropic.claude-sonnet-4-6',
          input: { used: 1, limit: 2 },
          output: { used: 0, limit: null },
          status: 'ok',
        },
        {
          modelId: 'global.anthropic.claude-opus-5-5',
          input: { used: 1, limit: 2 },
          output: { used: 0, limit: null },
          status: 'ok',
        },
      ],
      metadata: { requestId: 'r' },
    });

    const summary = await getMyUsage();

    expect(backendClient.get).toHaveBeenCalledWith('/usage/me');
    expect(summary).not.toHaveProperty('metadata');
    expect(summary.models.map((m) => m.modelKey)).toEqual([
      'anthropic.claude-sonnet-4-6',
      'anthropic.claude-opus-5-5',
    ]);
    expect(summary.models[1]).not.toHaveProperty('modelId');
  });

  it('treats a disabled response without models as empty', async () => {
    vi.mocked(backendClient.get).mockResolvedValue({
      enabled: false,
      period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '' },
    });
    const summary = await getMyUsage();
    expect(summary).toMatchObject({ enabled: false, groups: [], models: [] });
  });
});
