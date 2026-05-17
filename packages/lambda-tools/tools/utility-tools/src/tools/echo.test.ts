/**
 * Echo tool tests
 */

import { echoTool } from './echo.js';
import { ToolValidationError, ToolInput } from '@moca/lambda-tools-shared';

describe('Echo Tool', () => {
  describe('正常系テスト', () => {
    test('メッセージが正しくエコーされる', async () => {
      const input: ToolInput = {
        message: 'Hello World',
      };

      const result = await echoTool.handler(input);

      expect(result.echo).toBe('Hello World');
    });

    test('大文字・小文字変換が正しい', async () => {
      const input: ToolInput = {
        message: 'Hello World',
      };

      const result = await echoTool.handler(input);

      expect(result.uppercase).toBe('HELLO WORLD');
      expect(result.lowercase).toBe('hello world');
    });

    test('文字数カウントが正しい', async () => {
      const input: ToolInput = {
        message: 'Hello World',
      };

      const result = await echoTool.handler(input);

      expect(result.length).toBe(11);
    });

    test('日本語メッセージが正しく処理される', async () => {
      const input: ToolInput = {
        message: 'こんにちは世界',
      };

      const result = await echoTool.handler(input);

      expect(result.echo).toBe('こんにちは世界');
      expect(result.length).toBe(7);
      expect(result.uppercase).toBe('こんにちは世界'); // Japanese characters are not converted to uppercase/lowercase
      expect(result.lowercase).toBe('こんにちは世界');
    });

    test('空文字列が正しく処理される', async () => {
      const input: ToolInput = {
        message: '',
      };

      const result = await echoTool.handler(input);

      expect(result.echo).toBe('');
      expect(result.length).toBe(0);
      expect(result.uppercase).toBe('');
      expect(result.lowercase).toBe('');
    });

    test('特殊文字を含むメッセージが正しく処理される', async () => {
      const input: ToolInput = {
        message: '!@#$%^&*()_+-={}[]|\\:";\'<>?,./`~',
      };

      const result = await echoTool.handler(input);

      expect(result.echo).toBe('!@#$%^&*()_+-={}[]|\\:";\'<>?,./`~');
      expect(result.length).toBe(32);
    });

    test('数字を含むメッセージが正しく処理される', async () => {
      const input: ToolInput = {
        message: 'Test123',
      };

      const result = await echoTool.handler(input);

      expect(result.echo).toBe('Test123');
      expect(result.length).toBe(7);
      expect(result.uppercase).toBe('TEST123');
      expect(result.lowercase).toBe('test123');
    });
  });

  describe('異常系テスト', () => {
    test('messageがない場合にToolValidationErrorがスローされる', async () => {
      const input: ToolInput = {};

      await expect(echoTool.handler(input)).rejects.toThrow(ToolValidationError);
    });

    test('messageがundefinedの場合にToolValidationErrorがスローされる', async () => {
      const input: ToolInput = {
        message: undefined,
      };

      await expect(echoTool.handler(input)).rejects.toThrow(ToolValidationError);
    });

    test('messageがnullの場合にToolValidationErrorがスローされる', async () => {
      const input: ToolInput = {
        message: null as any,
      };

      await expect(echoTool.handler(input)).rejects.toThrow(ToolValidationError);
    });

    test('ToolValidationErrorに正しい情報が含まれる', async () => {
      const input: ToolInput = {};

      try {
        await echoTool.handler(input);
        fail('例外がスローされるはずです');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolValidationError);
        const toolError = error as ToolValidationError;
        expect(toolError.toolName).toBe('echo');
        expect(toolError.field).toBe('message');
        expect(toolError.message).toContain("Echo tool requires a 'message' parameter");
      }
    });
  });

  describe('ツール定義テスト', () => {
    test('ツール名が正しい', () => {
      expect(echoTool.name).toBe('echo');
    });

    test('説明が設定されている', () => {
      expect(echoTool.description).toBeDefined();
      expect(typeof echoTool.description).toBe('string');
    });

    test('バージョンが設定されている', () => {
      expect(echoTool.version).toBe('1.0.0');
    });

    test('タグが設定されている', () => {
      expect(echoTool.tags).toEqual(['utility', 'text-processing']);
    });

    test('ハンドラー関数が設定されている', () => {
      expect(typeof echoTool.handler).toBe('function');
    });
  });
});
