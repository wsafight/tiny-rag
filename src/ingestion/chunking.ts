import type { SemanticChunk } from './types';
import { invariant } from '../utils/index';

/**
 * 把过长的段落按字符长度硬切，相邻块之间保留固定重叠。
 * 当 overlap >= size 时会抛错，避免切块无法向前推进。
 */
export function splitByLength(text: string, size: number, overlap: number): string[] {
  invariant(!Number.isFinite(size) || size <= 0, `splitByLength: size 必须为正整数，收到 ${size}`);
  invariant(
    !Number.isFinite(overlap) || overlap < 0 || overlap >= size,
    `splitByLength: overlap 必须在 [0, size) 内，收到 ${overlap}`,
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
 * 语义切块：优先按 Markdown 标题分节，再按空行段落贪心聚合，最后按长度兜底。
 * 同时为每个 chunk 拼接所属标题路径，便于检索时模型理解上下文。
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
