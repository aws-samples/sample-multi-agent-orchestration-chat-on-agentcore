/**
 * Knip preprocessor: drops "unused export" issues that point at a re-export
 * (`export { x } from './y'`).
 *
 * Barrels expose a module's whole surface on purpose, so a re-export that no one
 * imports yet is not dead code. Knip still reports the declaration itself when
 * nothing uses it, and that report is kept.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

interface Issue {
  filePath: string;
  pos?: number;
}
type IssueGroup = Record<string, Record<string, Issue>>;
interface ReporterOptions {
  issues: Record<string, IssueGroup>;
  counters: Record<string, number>;
}

const GROUPS = ['exports', 'types'];

/** `[start, end)` of every `export … from '…'` statement in the source text. */
export function reExportRanges(sourceText: string): Array<[number, number]> {
  const sourceFile = ts.createSourceFile('file.tsx', sourceText, ts.ScriptTarget.Latest, false);
  return sourceFile.statements
    .filter((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier)
    .map((statement) => [statement.getStart(sourceFile), statement.end]);
}

export default function ignoreReExports<T extends ReporterOptions>(options: T): T {
  const rangesByFile = new Map<string, Array<[number, number]>>();
  const rangesOf = (filePath: string): Array<[number, number]> => {
    let ranges = rangesByFile.get(filePath);
    if (!ranges) {
      ranges = reExportRanges(readFileSync(filePath, 'utf8'));
      rangesByFile.set(filePath, ranges);
    }
    return ranges;
  };

  for (const group of GROUPS) {
    for (const [file, issuesBySymbol] of Object.entries(options.issues[group] ?? {})) {
      for (const [symbol, issue] of Object.entries(issuesBySymbol)) {
        const pos = issue.pos;
        if (pos === undefined) continue;
        if (!rangesOf(issue.filePath).some(([start, end]) => pos >= start && pos < end)) continue;
        delete issuesBySymbol[symbol];
        options.counters[group] -= 1;
        options.counters.total -= 1;
      }
      if (Object.keys(issuesBySymbol).length === 0) delete options.issues[group][file];
    }
  }
  return options;
}
