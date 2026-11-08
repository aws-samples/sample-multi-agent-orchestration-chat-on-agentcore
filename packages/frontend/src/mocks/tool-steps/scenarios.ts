import type { Segment, Step, StepGroup } from './types';

/** Static definition of a turn; `snapshotAt` turns it into what the UI sees at time t. */
type StepDef =
  | {
      kind: 'tool';
      name: string;
      input: Record<string, unknown>;
      result: string;
      isError?: boolean;
      durationMs: number;
      children?: StepDef[];
    }
  | { kind: 'reasoning'; text: string; durationMs: number };

type ItemDef =
  | { type: 'text'; text: string }
  | { type: 'steps'; steps: StepDef[] }
  | { type: 'ui'; title: string };

export interface Scenario {
  id: string;
  label: string;
  userPrompt: string;
  items: ItemDef[];
}

const search = (query: string, ms = 1400): StepDef => ({
  kind: 'tool',
  name: 'tavily_search',
  input: { query, max_results: 5 },
  result: JSON.stringify(
    {
      results: [
        { title: `${query} - 概要`, url: 'https://example.com/a', score: 0.92 },
        { title: `${query} の最新動向`, url: 'https://example.com/b', score: 0.87 },
      ],
    },
    null,
    2
  ),
  durationMs: ms,
});

const browse = (url: string, ms = 2200, isError = false): StepDef => ({
  kind: 'tool',
  name: 'browser',
  input: { action: 'navigate', url },
  result: isError
    ? 'Error: net::ERR_CONNECTION_TIMED_OUT while loading ' + url
    : `# ${url}\n\nページ本文 (抜粋) ...\n- 項目 1\n- 項目 2`,
  isError,
  durationMs: ms,
});

const think = (text: string, ms = 1800): StepDef => ({ kind: 'reasoning', text, durationMs: ms });

export const scenarios: Scenario[] = [
  {
    id: 'research',
    label: '長いリサーチ (14 + 7 ステップ)',
    userPrompt: '国内の生成 AI 導入状況を調べて、業種別の比較表とグラフを作って',
    items: [
      {
        type: 'steps',
        steps: [
          think(
            'ユーザーは業種別の比較を求めている。まず公的統計と民間調査の両方を探し、数字の定義を揃える必要がある。'
          ),
          {
            kind: 'tool',
            name: 'todo',
            input: {
              todos: ['公的統計を検索', '民間調査を検索', '数値を正規化', 'グラフ作成'],
            },
            result: 'Todo list updated (4 items)',
            durationMs: 300,
          },
          search('生成AI 導入率 業種別 2026 総務省'),
          search('生成AI 企業 利用状況 調査 2026'),
          search('generative AI adoption Japan industry survey'),
          browse('https://www.soumu.go.jp/johotsusintokei/whitepaper/'),
          browse('https://example-research.co.jp/report/genai-2026', 4000, true),
          browse('https://example-research.co.jp/report/genai-2026?retry=1', 2600),
          think('総務省データは 2025 年度末時点、民間調査は 2026 年 6 月時点。時点差を注記する。'),
          search('製造業 生成AI 活用事例 割合'),
          search('金融業 生成AI 導入 割合 2026'),
          search('小売業 生成AI 導入 割合 2026'),
          browse('https://example.com/finance-genai'),
          browse('https://example.com/retail-genai'),
        ],
      },
      {
        type: 'text',
        text: '公的統計と民間調査から業種別の導入率を集めました。時点が異なるため注記付きで整理します。続いて数値を集計してグラフにします。',
      },
      {
        type: 'steps',
        steps: [
          {
            kind: 'tool',
            name: 'code_interpreter',
            input: {
              language: 'python',
              code: "import pandas as pd\ndf = pd.DataFrame({'業種': ['製造', '金融', '小売'], '導入率': [42, 61, 35]})\nprint(df)",
            },
            result: '   業種  導入率\n0  製造   42\n1  金融   61\n2  小売   35',
            durationMs: 3200,
          },
          {
            kind: 'tool',
            name: 'code_interpreter',
            input: { language: 'python', code: "df.plot.bar(x='業種', y='導入率')\nplt.savefig('chart.png')" },
            result: "Traceback (most recent call last):\n  NameError: name 'plt' is not defined",
            isError: true,
            durationMs: 1500,
          },
          think('matplotlib の import が漏れていた。修正して再実行する。', 900),
          {
            kind: 'tool',
            name: 'code_interpreter',
            input: {
              language: 'python',
              code: "import matplotlib.pyplot as plt\ndf.plot.bar(x='業種', y='導入率')\nplt.savefig('chart.png')",
            },
            result: 'Saved chart.png',
            durationMs: 2800,
          },
          {
            kind: 'tool',
            name: 'file_editor',
            input: { command: 'create', path: '/workspace/report/genai-adoption.md' },
            result: 'File created: /workspace/report/genai-adoption.md',
            durationMs: 500,
          },
          {
            kind: 'tool',
            name: 'call_agent',
            input: { agent: 'レビュー担当', task: '比較表の数値と出典の整合性を確認して' },
            result: '出典 3 件すべて確認済み。金融の数値は 2026/06 時点と注記を推奨。',
            durationMs: 6000,
            children: [
              search('金融業 生成AI 導入率 出典確認', 1200),
              browse('https://example.com/finance-genai', 1500),
              think('数値は一致。時点の注記が必要。', 800),
            ],
          },
          {
            kind: 'tool',
            name: 'generate_ui',
            input: { component: 'BarChart', title: '業種別 生成 AI 導入率' },
            result: '{"spec": "..."}',
            durationMs: 700,
          },
        ],
      },
      { type: 'ui', title: '業種別 生成 AI 導入率 (生成 UI)' },
      {
        type: 'text',
        text: '**まとめ**: 金融 61% / 製造 42% / 小売 35%。金融が最も高く、小売は人手不足領域から導入が進んでいます。レポートは `/workspace/report/genai-adoption.md` に保存しました。',
      },
    ],
  },
  {
    id: 'single',
    label: '単発のツール呼び出し (1 ステップ)',
    userPrompt: '東京の今日の天気は？',
    items: [
      { type: 'steps', steps: [search('東京 天気 今日', 1200)] },
      { type: 'text', text: '東京は晴れ、最高気温 18℃ の予報です。' },
    ],
  },
  {
    id: 'interleaved',
    label: 'テキストとツールが交互 (3 グループ)',
    userPrompt: 'リポジトリのテストを直して',
    items: [
      { type: 'text', text: 'まずテストを実行して失敗箇所を確認します。' },
      {
        type: 'steps',
        steps: [
          {
            kind: 'tool',
            name: 'execute_command',
            input: { command: 'npm test' },
            result: 'FAIL src/auth.test.ts\n  ✕ refreshes expired token (12 ms)\nTests: 1 failed, 41 passed',
            durationMs: 5200,
          },
        ],
      },
      { type: 'text', text: 'トークン更新のテストが 1 件失敗しています。実装を確認します。' },
      {
        type: 'steps',
        steps: [
          {
            kind: 'tool',
            name: 'file_editor',
            input: { command: 'view', path: 'src/auth.ts' },
            result: 'export function refresh() { ... }',
            durationMs: 400,
          },
          {
            kind: 'tool',
            name: 'file_editor',
            input: { command: 'view', path: 'src/auth.test.ts' },
            result: "it('refreshes expired token', ...)",
            durationMs: 400,
          },
          think('期限判定が <= ではなく < になっている。境界値でずれる。', 1200),
          {
            kind: 'tool',
            name: 'file_editor',
            input: { command: 'str_replace', path: 'src/auth.ts', old_str: 'exp < now', new_str: 'exp <= now' },
            result: 'Replaced 1 occurrence',
            durationMs: 300,
          },
          {
            kind: 'tool',
            name: 'execute_command',
            input: { command: 'npm test' },
            result: 'Tests: 42 passed',
            durationMs: 5000,
          },
        ],
      },
      { type: 'text', text: '期限判定の境界条件を修正し、テストは全件成功しました。' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Replay: what the UI shows at elapsed time t (ms since the turn started).
// ---------------------------------------------------------------------------

const TEXT_MS_PER_CHAR = 18;

const stepTotalMs = (s: StepDef) => s.durationMs;
const itemTotalMs = (item: ItemDef): number =>
  item.type === 'text'
    ? item.text.length * TEXT_MS_PER_CHAR
    : item.type === 'steps'
      ? item.steps.reduce((sum, s) => sum + stepTotalMs(s), 0)
      : 0;

export const scenarioDurationMs = (sc: Scenario) =>
  sc.items.reduce((sum, item) => sum + itemTotalMs(item), 0);

function materialize(def: StepDef, id: string, startAt: number, t: number, t0: number): Step | null {
  if (t < startAt) return null;
  const done = t >= startAt + def.durationMs;
  const base = { id, startedAt: t0 + startAt, durationMs: done ? def.durationMs : undefined };
  if (def.kind === 'reasoning') {
    // Reasoning streams in proportionally to elapsed time.
    const frac = done ? 1 : (t - startAt) / def.durationMs;
    return {
      ...base,
      kind: 'reasoning',
      text: def.text.slice(0, Math.max(1, Math.ceil(def.text.length * frac))),
      status: done ? 'completed' : 'running',
    };
  }
  let children: Step[] | undefined;
  if (def.children) {
    children = [];
    let c = startAt;
    def.children.forEach((child, i) => {
      const m = materialize(child, `${id}.${i}`, c, t, t0);
      if (m) children!.push(m);
      c += child.durationMs;
    });
  }
  return {
    ...base,
    kind: 'tool',
    name: def.name,
    input: def.input,
    result: done ? def.result : undefined,
    status: done ? (def.isError ? 'error' : 'completed') : 'running',
    children,
  };
}

/** t = Infinity gives the finished turn (as loaded from history). */
export function snapshotAt(
  sc: Scenario,
  t: number,
  t0: number
): { segments: Segment[]; isStreaming: boolean } {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [i, item] of sc.items.entries()) {
    if (t < cursor) break;
    const id = `${sc.id}-${i}`;
    if (item.type === 'text') {
      const chars = Math.floor((t - cursor) / TEXT_MS_PER_CHAR);
      segments.push({ type: 'text', id, text: item.text.slice(0, Math.max(1, chars)) });
    } else if (item.type === 'ui') {
      segments.push({ type: 'ui', id, title: item.title });
    } else {
      const group: StepGroup = { id, steps: [] };
      let c = cursor;
      item.steps.forEach((s, j) => {
        const m = materialize(s, `${id}.${j}`, c, t, t0);
        if (m) group.steps.push(m);
        c += s.durationMs;
      });
      segments.push({ type: 'steps', group });
    }
    cursor += itemTotalMs(item);
  }
  return { segments, isStreaming: t < cursor };
}
