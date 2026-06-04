import type { SemanticChunk } from './types';
import { invariant } from '../utils/index';

/**
 * Hard-split an overly long paragraph by character length, keeping a fixed overlap between adjacent chunks.
 * Throws when overlap >= size to avoid chunking that cannot move forward.
 */
export function splitByLength(text: string, size: number, overlap: number): string[] {
  invariant(!Number.isFinite(size) || size <= 0, `splitByLength: size must be a positive integer, received ${size}`);
  invariant(
    !Number.isFinite(overlap) || overlap < 0 || overlap >= size,
    `splitByLength: overlap must be within [0, size), received ${overlap}`,
  );
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  const step = size - overlap;
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    const slice = text.slice(start, end).trim();
    if (slice.length > 0) chunks.push(slice);
    if (end === text.length) break;
    start += step;
  }
  return chunks;
}

/**
 * Semantic chunking: split by Markdown headings first, then greedily aggregate paragraphs by blank lines, falling back to length-based splitting.
 * Also prepends the heading path to each chunk so the model can understand context during retrieval.
 */
export function splitSemantic(text: string, size: number, overlap: number): SemanticChunk[] {
  const cleaned = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');

  const sections: Array<{ headingPath: string[]; body: string }> = [];
  let current: { headingPath: string[]; buffer: string[] } = { headingPath: [], buffer: [] };
  const headingStack: Array<{ level: number; title: string }> = [];
  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (current.buffer.length > 0) {
        sections.push({ headingPath: [...current.headingPath], body: current.buffer.join('\n') });
        current.buffer = [];
      }
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      current.headingPath = headingStack.map((h) => h.title);
    } else {
      current.buffer.push(line);
    }
  }
  if (current.buffer.length > 0) {
    sections.push({ headingPath: [...current.headingPath], body: current.buffer.join('\n') });
  }
  if (sections.length === 0) {
    sections.push({ headingPath: [], body: cleaned });
  }

  const result: SemanticChunk[] = [];
  for (const section of sections) {
    const headingStr = section.headingPath.join(' > ');
    const paragraphs = section.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    let buf = '';
    const flush = () => {
      if (!buf.trim()) return;
      const subs = splitByLength(buf.trim(), size, overlap);
      for (const sub of subs) result.push({ content: sub, heading: headingStr });
      buf = '';
    };

    for (const p of paragraphs) {
      if (buf.length + p.length + 2 <= size) {
        buf = buf ? `${buf}\n\n${p}` : p;
      } else {
        flush();
        if (p.length > size) {
          for (const sub of splitByLength(p, size, overlap)) {
            result.push({ content: sub, heading: headingStr });
          }
        } else {
          buf = p;
        }
      }
    }
    flush();
  }
  return result;
}
