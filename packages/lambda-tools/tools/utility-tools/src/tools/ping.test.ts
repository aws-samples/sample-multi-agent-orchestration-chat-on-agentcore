/**
 * Ping tool tests
 */

import { pingTool } from './ping.js';
import { ToolInput } from '@moca/lambda-tools-shared';

describe('Ping Tool', () => {
  describe('正常系テスト', () => {
    test('statusが"pong"である', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(result.status).toBe('pong');
    });

    test('timestampがISO形式である', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(typeof result.timestamp).toBe('string');
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Verify that the difference from the current time is within 1 second
      const timestampDate = new Date(result.timestamp as string);
      const now = new Date();
      const diff = Math.abs(now.getTime() - timestampDate.getTime());
      expect(diff).toBeLessThan(1000); // within 1 second
    });

    test('uptimeが数値である', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(typeof result.uptime).toBe('number');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    test('Node.jsのversionが含まれる', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(typeof result.version).toBe('string');
      expect(result.version).toMatch(/^v\d+\.\d+\.\d+/); // Format like v18.17.0
      expect(result.version).toBe(process.version);
    });

    test('platformが含まれる', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(typeof result.platform).toBe('string');
      expect(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos']).toContain(
        result.platform
      );
      expect(result.platform).toBe(process.platform);
    });

    test('architectureが含まれる', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(typeof result.arch).toBe('string');
      expect(['x64', 'arm64', 'arm', 'ia32', 's390x', 'mips', 'ppc64']).toContain(result.arch);
      expect(result.arch).toBe(process.arch);
    });

    test('memoryオブジェクトが含まれる', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(typeof result.memory).toBe('object');
      expect(result.memory).not.toBeNull();

      const memory = result.memory as NodeJS.MemoryUsage;

      // Verify that each memory usage value is a number and a positive value
      expect(typeof memory.rss).toBe('number');
      expect(memory.rss).toBeGreaterThan(0);

      expect(typeof memory.heapTotal).toBe('number');
      expect(memory.heapTotal).toBeGreaterThan(0);

      expect(typeof memory.heapUsed).toBe('number');
      expect(memory.heapUsed).toBeGreaterThan(0);

      expect(typeof memory.external).toBe('number');
      expect(memory.external).toBeGreaterThanOrEqual(0);

      expect(typeof memory.arrayBuffers).toBe('number');
      expect(memory.arrayBuffers).toBeGreaterThanOrEqual(0);

      // Verify the relationship heapUsed <= heapTotal
      expect(memory.heapUsed).toBeLessThanOrEqual(memory.heapTotal);
    });
  });

  describe('エッジケーステスト', () => {
    test('入力が空でも正常に動作する', async () => {
      const input: ToolInput = {};

      const result = await pingTool.handler(input);

      expect(result.status).toBe('pong');
      expect(result.timestamp).toBeDefined();
      expect(result.uptime).toBeDefined();
      expect(result.version).toBeDefined();
      expect(result.platform).toBeDefined();
      expect(result.arch).toBeDefined();
      expect(result.memory).toBeDefined();
    });

    test('入力にプロパティがあっても正常に動作する', async () => {
      const input: ToolInput = {
        message: 'test message',
        someOtherProperty: 'value',
      };

      const result = await pingTool.handler(input);

      expect(result.status).toBe('pong');
      expect(result.timestamp).toBeDefined();
      expect(result.uptime).toBeDefined();
      expect(result.version).toBeDefined();
      expect(result.platform).toBeDefined();
      expect(result.arch).toBeDefined();
      expect(result.memory).toBeDefined();
    });

    test('nullの入力でも正常に動作する', async () => {
      const input = null as any;

      const result = await pingTool.handler(input);

      expect(result.status).toBe('pong');
      expect(result.timestamp).toBeDefined();
    });

    test('undefinedの入力でも正常に動作する', async () => {
      const input = undefined as any;

      const result = await pingTool.handler(input);

      expect(result.status).toBe('pong');
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('ツール定義テスト', () => {
    test('ツール名が正しい', () => {
      expect(pingTool.name).toBe('ping');
    });

    test('説明が設定されている', () => {
      expect(pingTool.description).toBeDefined();
      expect(typeof pingTool.description).toBe('string');
      expect(pingTool.description).toBe('Health check and system information tool');
    });

    test('バージョンが設定されている', () => {
      expect(pingTool.version).toBe('1.0.0');
    });

    test('タグが設定されている', () => {
      expect(pingTool.tags).toEqual(['health-check', 'system-info', 'monitoring']);
    });

    test('ハンドラー関数が設定されている', () => {
      expect(typeof pingTool.handler).toBe('function');
    });
  });

  describe('パフォーマンステスト', () => {
    test('実行時間が適切な範囲内である', async () => {
      const input: ToolInput = {};
      const startTime = Date.now();

      await pingTool.handler(input);

      const executionTime = Date.now() - startTime;
      // ping is a lightweight operation, so expect completion within 100ms
      expect(executionTime).toBeLessThan(100);
    });

    test('連続実行でもパフォーマンスが安定している', async () => {
      const input: ToolInput = {};
      const executionTimes: number[] = [];

      // Run 10 times consecutively
      for (let i = 0; i < 10; i++) {
        const startTime = Date.now();
        await pingTool.handler(input);
        executionTimes.push(Date.now() - startTime);
      }

      // Verify that all executions complete within 100ms
      executionTimes.forEach((time) => {
        expect(time).toBeLessThan(100);
      });

      // Verify that the average execution time is within 50ms
      const averageTime =
        executionTimes.reduce((sum, time) => sum + time, 0) / executionTimes.length;
      expect(averageTime).toBeLessThan(50);
    });
  });
});
