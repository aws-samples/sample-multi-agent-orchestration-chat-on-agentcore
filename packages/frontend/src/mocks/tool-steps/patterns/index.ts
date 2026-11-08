import type React from 'react';
import type { StepGroupViewProps } from '../types';
import { CurrentPattern } from './Current';
import { PatternA } from './PatternA';
import { PatternB } from './PatternB';
import { PatternC } from './PatternC';
import { PatternD } from './PatternD';

export interface PatternEntry {
  id: string;
  name: string;
  summary: string;
  Component: React.FC<StepGroupViewProps>;
}

export const patterns: PatternEntry[] = [
  {
    id: 'current',
    name: '現状',
    summary: 'ツール呼び出し・結果・推論をすべて個別ブロックで縦に並べる',
    Component: CurrentPattern,
  },
  {
    id: 'a',
    name: 'A: 要約 1 行アコーディオン',
    summary: '実行中は最新ステップを 1 行で見せ、完了後は「24 ステップ・42 秒」の 1 行に畳む',
    Component: PatternA,
  },
  {
    id: 'b',
    name: 'B: タイムライン',
    summary: '縦線とドットのタイムライン。同じツールの連続は束ね、古いステップは「さらに N 件」で隠す',
    Component: PatternB,
  },
  {
    id: 'c',
    name: 'C: ツールチップ列',
    summary: '使ったツールをアイコン付きチップで横並びに表示。チップを押すと詳細がその下に開く',
    Component: PatternC,
  },
  {
    id: 'd',
    name: 'D: インスペクターパネル',
    summary: 'チャット内はステータス 1 行だけ。詳細は右側のパネルで一覧・検索する',
    Component: PatternD,
  },
];
