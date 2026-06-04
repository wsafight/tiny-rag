import type { KeywordStats, TermCounts } from '../storage/types';

export function tokenizeForKeyword(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const tokens: string[] = [];
  const matches = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
  for (const part of matches) {
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      if (part.length === 1) {
        tokens.push(part);
      } else {
        for (let i = 0; i < part.length - 1; i++) {
          tokens.push(part.slice(i, i + 2));
        }
      }
    } else if (part.length > 0) {
      tokens.push(part);
    }
  }
  return tokens;
}

function countTerms(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function toTermCounts(counts: ReadonlyMap<string, number>): TermCounts {
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function buildKeywordStats(heading: string, content: string): Required<KeywordStats> {
  const headingTokens = tokenizeForKeyword(heading);
  const contentTokens = tokenizeForKeyword(content);
  return {
    keywordHeadingTerms: toTermCounts(countTerms(headingTokens)),
    keywordHeadingTokenCount: headingTokens.length,
    keywordContentTerms: toTermCounts(countTerms(contentTokens)),
    keywordContentTokenCount: contentTokens.length,
  };
}
