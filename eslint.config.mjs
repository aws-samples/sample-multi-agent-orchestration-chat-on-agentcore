import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // New rules added in eslint:recommended (eslint 10) - set to warn for gradual adoption
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  // Agent package: enforce .js extension in ESM mode
  {
    files: ['packages/agent/**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/extensions': [
        'error',
        'ignorePackages',
        {
          ts: 'never',
          js: 'always', // .js required for local imports
        },
      ],
    },
  },
  // s3-workspace-sync package: enforce .js extension in ESM mode
  {
    files: ['packages/shared/s3-workspace-sync/**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/extensions': [
        'error',
        'ignorePackages',
        {
          ts: 'never',
          js: 'always',
        },
      ],
    },
  },
  // Backend-like TS packages (agent, backend, trigger, session-stream-handler):
  // forbid `console.*` and require `logger` (libs/logger), and forbid emojis /
  // non-English natural-language text in logger/console calls.
  //
  // `console.log(msg, obj)` causes Node's util.inspect to multi-line-expand the
  // object, which CloudWatch Logs then splits into separate events — breaking
  // Logs Insights queries and inflating cost. pino emits one NDJSON line per
  // event so `fields scope, msg, ...` is queryable. The logger module itself
  // (libs/logger/**) needs stdout access, so it's the only exception.
  //
  // Rules enforced here:
  //   - `no-console: error`: route all logging through `logger`.
  //   - `no-restricted-syntax`:
  //       1. Forbid `logger.X("message", { obj })` / `(…, err)` / `(…, new Error())`
  //          — these drop or multi-line-inspect the trailing arg. Use pino-native
  //          `logger.X({ ...fields }, "message")` instead.
  //       2. Forbid emojis and CJK text inside logger/console string args.
  //          Log output should stay English ASCII for grep/CloudWatch Insights.
  //
  // Scope: all backend-style TS packages — not just agent/backend. trigger and
  // session-stream-handler are also prod Lambdas writing to CloudWatch.
  {
    files: [
      'packages/agent/src/**/*.ts',
      'packages/backend/src/**/*.ts',
      'packages/trigger/src/**/*.ts',
      'packages/session-stream-handler/src/**/*.ts',
    ],
    ignores: [
      '**/__tests__/**',
      '**/tests/**',
      '**/*.test.ts',
      '**/*.spec.ts',
      'packages/*/src/libs/logger/**',
    ],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        // Pino call-shape checks.
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(debug|info|warn|error|trace|fatal)$/][callee.object.name=/^(logger|log)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/][arguments.1.type='ObjectExpression']",
          message:
            'Use pino-native `logger.X({ ...fields }, "message")`. `logger.X("message", { ... })` silently drops or multi-line-inspects the object.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(debug|info|warn|error|trace|fatal)$/][callee.object.name=/^(logger|log)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/][arguments.1.type='Identifier'][arguments.1.name=/^(err|error|e|lastError|execError|parseError|cleanupError|streamError)$/]",
          message:
            'Use pino-native `logger.X({ err }, "message")`. pino drops trailing Error objects unless wrapped under a key.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(debug|info|warn|error|trace|fatal)$/][callee.object.name=/^(logger|log)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/][arguments.1.type='NewExpression']",
          message:
            'Use pino-native `logger.X({ err: new X() }, "message")`. pino drops trailing Error objects unless wrapped under a key.',
        },
        // Forbid emojis and CJK inside logger/log/console calls.
        //   Emojis: U+1F100-1F2FF (Enclosed Alphanumeric/Ideographic Supplement),
        //           U+1F300-1FAFF (Misc Symbols & Pictographs / Emoticons /
        //           Transport / Pictographs Extended-A), U+2300-23FF (Misc
        //           Technical — ⏳ ⏭ etc.), U+2600-27BF (Misc Symbols, Dingbats),
        //           U+2B00-2BFF (Misc Symbols and Arrows).
        //   CJK: U+3040-309F (Hiragana), U+30A0-30FF (Katakana),
        //        U+4E00-9FFF (CJK Unified Ideographs).
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(debug|info|warn|error|trace|fatal|log)$/][callee.object.name=/^(logger|log|console)$/] Literal[value=/[\\u{1F100}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{3040}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{4E00}-\\u{9FFF}]/u]",
          message:
            'Do not use emojis or non-English text in logger/console calls. Keep log messages English ASCII.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(debug|info|warn|error|trace|fatal|log)$/][callee.object.name=/^(logger|log|console)$/] TemplateElement[value.raw=/[\\u{1F100}-\\u{1FAFF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{3040}-\\u{309F}\\u{30A0}-\\u{30FF}\\u{4E00}-\\u{9FFF}]/u]",
          message:
            'Do not use emojis or non-English text in logger/console calls. Keep log messages English ASCII.',
        },
      ],
    },
  },
  // Frontend package: apply React-related rules
  {
    files: ['packages/frontend/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Test files: disable no-explicit-any
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // CommonJS config files (e.g. jest.config.cjs): require() is the correct pattern
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ─── `process.env` Centralization Rule ──────────────────────────────────────
  //
  // Direct reads of `process.env.X` (and `process.env[key]`) are forbidden
  // outside the `config/` layer in agent and backend. Environment variables
  // must be declared in `src/config/index.ts` (Zod schema) and consumed via
  // the parsed `config.X` import. This keeps:
  //   - required/optional definitions in one Zod source of truth,
  //   - type coercion (e.g. `PORT: string → number`) in one place,
  //   - test mocking concentrated on a single import boundary.
  //
  // Selector explanation:
  //   `process.env.FOO` parses as
  //     MemberExpression(
  //       object: MemberExpression(object: 'process', property: 'env'),
  //       property: 'FOO'
  //     )
  //   We match the OUTER MemberExpression so both dot (`process.env.FOO`) and
  //   computed (`process.env[key]`) accesses are caught. The bare-reference
  //   form `...process.env` (SpreadElement argument) is intentionally NOT
  //   matched — child-process spawn (`execute-command`, `mcp/client-factory`)
  //   legitimately needs to forward the entire env block, and rewriting that
  //   through config would just re-export the full env unchanged.
  //
  // Exemptions (via `ignores`):
  //   - `**/config/**`        : reading env is the layer's responsibility.
  //   - `**/libs/logger/**`   : pino bootstrap reads NODE_ENV / LOG_LEVEL
  //                              before config is importable; routing it
  //                              through config would create a logger ↔ config
  //                              cycle (config itself logs validation errors).
  //   - tests                  : integration-test setup mutates process.env to
  //                              point SDKs at DynamoDB Local etc.
  {
    files: ['packages/agent/src/**/*.ts', 'packages/backend/src/**/*.ts'],
    ignores: [
      'packages/agent/src/config/**',
      'packages/backend/src/config/**',
      'packages/agent/src/libs/logger/**',
      'packages/backend/src/libs/logger/**',
      '**/__tests__/**',
      '**/tests/**',
      '**/*.test.ts',
      '**/*.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env']",
          message:
            'Do not read process.env directly outside the config layer. Declare the variable in src/config/index.ts (Zod schema) and import `config.X` instead. See packages/{agent,backend}/AGENTS.md.',
        },
      ],
    },
  },

  // ─── Layer Boundary Rules ───────────────────────────────────────────────────
  //
  // Replaces tests/architecture/layer-dependency.test.ts.
  // Enforces that imports only flow "downward" through the layer stack.
  //
  // Agent layer order (low → high):
  //   types(0) → config(1) → services(2) → runtime(3) → handlers(4)
  //   libs(-1): Provider layer — importable from any layer, but itself only
  //             depends on types and config.
  //
  // Backend layer order (low → high):
  //   types(0) → config(1) → middleware(2) → services(3) → routes(4)
  //   libs(-1): same provider rules as agent.
  //
  // Frontend layer order (low → high):
  //   foundation(0) → utils(1) → state(2) → components(3) → features(4) → pages(5)

  // ── Agent: layer boundaries ─────────────────────────────────────────────────
  {
    files: ['packages/agent/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      // Allow eslint-module-utils to resolve TypeScript files without extensions
      'import/extensions': ['.ts', '.tsx', '.js', '.jsx'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] } },
      'boundaries/elements': [
        { type: 'types', pattern: 'packages/agent/src/types/**' },
        { type: 'config', pattern: 'packages/agent/src/config/**' },
        { type: 'services', pattern: 'packages/agent/src/services/**' },
        { type: 'runtime', pattern: 'packages/agent/src/runtime/**' },
        { type: 'handlers', pattern: 'packages/agent/src/handlers/**' },
        // Provider layer: cross-cutting concerns (libs/ can only depend on types & config)
        { type: 'libs', pattern: 'packages/agent/src/libs/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // types: nothing below — no imports allowed
            { from: { type: 'types' }, disallow: { to: { type: '*' } } },
            // config: only types and libs
            { from: { type: 'config' }, allow: { to: { type: ['types', 'libs'] } } },
            // services: types, config, libs
            { from: { type: 'services' }, allow: { to: { type: ['types', 'config', 'libs'] } } },
            // runtime: types, config, services, libs
            {
              from: { type: 'runtime' },
              allow: { to: { type: ['types', 'config', 'services', 'libs'] } },
            },
            // handlers: all lower layers
            {
              from: { type: 'handlers' },
              allow: { to: { type: ['types', 'config', 'services', 'runtime', 'libs'] } },
            },
            // libs (Provider): only types and config
            { from: { type: 'libs' }, allow: { to: { type: ['types', 'config'] } } },
          ],
        },
      ],
    },
  },

  // ── Backend: layer boundaries ────────────────────────────────────────────────
  {
    files: ['packages/backend/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/extensions': ['.ts', '.tsx', '.js', '.jsx'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] } },
      'boundaries/elements': [
        { type: 'types', pattern: 'packages/backend/src/types/**' },
        { type: 'config', pattern: 'packages/backend/src/config/**' },
        { type: 'middleware', pattern: 'packages/backend/src/middleware/**' },
        { type: 'services', pattern: 'packages/backend/src/services/**' },
        { type: 'routes', pattern: 'packages/backend/src/routes/**' },
        // Provider layer
        { type: 'libs', pattern: 'packages/backend/src/libs/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: { type: 'types' }, disallow: { to: { type: '*' } } },
            { from: { type: 'config' }, allow: { to: { type: ['types', 'libs'] } } },
            {
              from: { type: 'middleware' },
              allow: { to: { type: ['types', 'config', 'libs'] } },
            },
            {
              from: { type: 'services' },
              allow: { to: { type: ['types', 'config', 'middleware', 'libs'] } },
            },
            {
              from: { type: 'routes' },
              allow: { to: { type: ['types', 'config', 'middleware', 'services', 'libs'] } },
            },
            { from: { type: 'libs' }, allow: { to: { type: ['types', 'config'] } } },
          ],
        },
      ],
    },
  },

  // ── Frontend: layer boundaries ───────────────────────────────────────────────
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'import/extensions': ['.ts', '.tsx', '.js', '.jsx'],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] } },
      'boundaries/elements': [
        // L0: foundation — types, config, schemas, locales, i18n
        {
          type: 'foundation',
          pattern: [
            'packages/frontend/src/types/**',
            'packages/frontend/src/config/**',
            'packages/frontend/src/schemas/**',
            'packages/frontend/src/locales/**',
            'packages/frontend/src/i18n/**',
          ],
        },
        // L1: utils
        {
          type: 'utils',
          pattern: ['packages/frontend/src/utils/**', 'packages/frontend/src/lib/**'],
        },
        // L2: state
        {
          type: 'state',
          pattern: [
            'packages/frontend/src/stores/**',
            'packages/frontend/src/api/**',
            'packages/frontend/src/hooks/**',
          ],
        },
        // L3: components
        {
          type: 'components',
          pattern: ['packages/frontend/src/components/**', 'packages/frontend/src/layouts/**'],
        },
        // L4: features
        { type: 'features', pattern: 'packages/frontend/src/features/**' },
        // L5: pages
        { type: 'pages', pattern: 'packages/frontend/src/pages/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: { type: 'foundation' }, disallow: { to: { type: '*' } } },
            { from: { type: 'utils' }, allow: { to: { type: 'foundation' } } },
            { from: { type: 'state' }, allow: { to: { type: ['foundation', 'utils'] } } },
            {
              from: { type: 'components' },
              allow: { to: { type: ['foundation', 'utils', 'state'] } },
            },
            {
              from: { type: 'features' },
              allow: { to: { type: ['foundation', 'utils', 'state', 'components'] } },
            },
            {
              from: { type: 'pages' },
              allow: {
                to: { type: ['foundation', 'utils', 'state', 'components', 'features'] },
              },
            },
          ],
        },
      ],
    },
  },

  {
    ignores: ['**/dist/**', '**/node_modules/**', 'cdk.out/**'],
  }
);
