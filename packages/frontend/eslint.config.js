import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import i18next from 'eslint-plugin-i18next';
import boundaries from 'eslint-plugin-boundaries';
import { fixupPluginRules } from '@eslint/compat';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      i18next: fixupPluginRules(i18next),
    },
    rules: {
      // New rules added in eslint:recommended (eslint 10) - set to warn for gradual adoption
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      // Route all browser logging through `utils/logger`, which is no-op in production.
      // Exceptions: `utils/logger.ts` itself (see override below) and test files.
      'no-console': 'error',
      // Forbid emojis and non-ASCII natural-language text (CJK) in logger/console calls.
      // Log output should stay English ASCII so it remains greppable, copy-safe, and
      // readable in terminals/CI log viewers regardless of locale.
      //
      // Covered ranges:
      //   - Emojis: U+1F100-1F2FF (Enclosed Alphanumeric/Ideographic Supplement),
      //             U+1F300-1FAFF (Misc Symbols & Pictographs, Emoticons, Transport,
      //             Symbols & Pictographs Extended-A), U+2300-23FF (Misc Technical —
      //             ⏳ ⏭ etc.), U+2600-27BF (Misc Symbols, Dingbats),
      //             U+2B00-2BFF (Misc Symbols and Arrows).
      //   - CJK: U+3040-309F (Hiragana), U+30A0-30FF (Katakana),
      //          U+4E00-9FFF (CJK Unified Ideographs).
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='logger'] Literal[value=/[\\u{1F100}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{3040}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{4E00}-\\u{9FFF}]/u]",
          message:
            'Do not use emojis or non-English text in logger calls. Keep log messages English ASCII.',
        },
        {
          selector:
            "CallExpression[callee.object.name='logger'] TemplateElement[value.raw=/[\\u{1F100}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{3040}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{4E00}-\\u{9FFF}]/u]",
          message:
            'Do not use emojis or non-English text in logger calls. Keep log messages English ASCII.',
        },
        {
          selector:
            "CallExpression[callee.object.name='console'] Literal[value=/[\\u{1F100}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{3040}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{4E00}-\\u{9FFF}]/u]",
          message:
            'Do not use emojis or non-English text in console calls. Keep log messages English ASCII.',
        },
        {
          selector:
            "CallExpression[callee.object.name='console'] TemplateElement[value.raw=/[\\u{1F100}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{3040}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{4E00}-\\u{9FFF}]/u]",
          message:
            'Do not use emojis or non-English text in console calls. Keep log messages English ASCII.',
        },
      ],
      'i18next/no-literal-string': [
        'warn',
        {
          mode: 'jsx-text-only',
          'jsx-attributes': {
            include: ['title', 'aria-label', 'alt', 'placeholder', 'label'],
          },
          words: {
            exclude: [
              // 数字のみ
              /^\d+$/,
              // CSS クラス名やIDなど
              /^[a-z]+(-[a-z]+)*$/,
              // URL
              /^https?:\/\//,
              // ファイルパス
              /^[./]/,
              // ASCII 特殊記号のみ（日本語文字列は除外しない）
              /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/,
              // 単一の大文字定数
              /^[A-Z_]+$/,
              // キーボードキー名（英語）
              /^(Enter|Shift|Ctrl|Alt|Tab|Escape|Backspace|Delete|Space|Command|Option|Meta|Return)$/i,
              // キーボード記号（Unicode）
              /^[⌘⇧⌃⌥⎋↵↩⇥⌫⌦]+$/,
              // プラス記号単体（キーボードショートカット表記用）
              /^\+$/,
              // 全角括弧（キーボードショートカット表記用）
              /^[（）]+$/,
              '↑↓',
              '⌘K',
              '⌘B',
              '⇧⌘O',
              '⌘/',
            ],
          },
          'should-validate-template': true,
          // テストファイルは除外
          ignoreAttribute: ['data-testid', 'data-*'],
        },
      ],
    },
  },
  // ── Frontend: layer boundaries ───────────────────────────────────────────────
  //
  // Layer order (low → high):
  //   foundation(0) → utils(1) → state(2) → components(3) → features(4) → pages(5)
  //
  // Test files are excluded: they may cross layer boundaries for test purposes.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/extensions': ['.ts', '.tsx', '.js', '.jsx'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] } },
      'boundaries/elements': [
        // L0: foundation — types, config, schemas, locales, i18n
        {
          type: 'foundation',
          pattern: [
            'src/types/**',
            'src/config/**',
            'src/schemas/**',
            'src/locales/**',
            'src/i18n/**',
          ],
        },
        // L1: utils
        { type: 'utils', pattern: ['src/utils/**', 'src/lib/**'] },
        // L2: state
        { type: 'state', pattern: ['src/stores/**', 'src/api/**', 'src/hooks/**'] },
        // L3: components
        { type: 'components', pattern: ['src/components/**', 'src/layouts/**'] },
        // L4: features
        { type: 'features', pattern: 'src/features/**' },
        // L5: pages
        { type: 'pages', pattern: 'src/pages/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // foundation: no outward imports (intra-layer allowed via same-type rule below)
            { from: { type: 'foundation' }, allow: { to: { type: 'foundation' } } },
            // utils: foundation + intra-layer
            { from: { type: 'utils' }, allow: { to: { type: ['foundation', 'utils'] } } },
            // state: foundation, utils + intra-layer (hooks can import stores and vice versa)
            {
              from: { type: 'state' },
              allow: { to: { type: ['foundation', 'utils', 'state'] } },
            },
            // components: foundation, utils, state + intra-layer
            {
              from: { type: 'components' },
              allow: { to: { type: ['foundation', 'utils', 'state', 'components'] } },
            },
            // features: foundation, utils, state, components + intra-layer
            {
              from: { type: 'features' },
              allow: {
                to: { type: ['foundation', 'utils', 'state', 'components', 'features'] },
              },
            },
            // pages: all lower layers + intra-layer
            {
              from: { type: 'pages' },
              allow: {
                to: {
                  type: ['foundation', 'utils', 'state', 'components', 'features', 'pages'],
                },
              },
            },
          ],
        },
      ],
    },
  },
  // Allow `console.*` inside the logger implementation itself and in tests.
  {
    files: [
      'src/utils/logger.ts',
      'src/**/__tests__/**',
      'src/**/*.test.{ts,tsx}',
      'src/**/*.spec.{ts,tsx}',
    ],
    rules: {
      'no-console': 'off',
    },
  },
]);
