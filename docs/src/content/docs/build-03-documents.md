---
title: "B03: 文档读取与 source"
description: 把文件系统输入变成稳定 SourceDocument，深度解释 source、排序和路径规范化为什么重要。
---

骨架和模型抽象立好后，第一段真实数据是磁盘上的文档。这一章实现 `loadDocuments()`，把一个目录里的 `.md` / `.txt` 读成 `SourceDocument[]`。

文档读取常被低估。它看起来只是 `readFile()`，但它决定了后面所有 chunk id、缓存 key、命中来源和用户排查体验。如果读取结果不稳定，embedding 缓存和向量库就会像建立在沙地上。

:::note[本章产出]
- **前置**：读完 `B01`–`B02`。准备几份 `.md` / `.txt` 测试文档（本章末尾会给命令生成）。
- **产出**：一份 `documents.ts`，导出 `loadDocuments()`，能递归读取目录、按路径排序、把 `source` 规范成 POSIX 相对路径。
- **本章不做**：不切块、不 embedding，只把文件变成 `{ source, content }` 数组。
:::

## 先理解：读取文档要稳定可重复

RAG 的第一步不是调用模型，而是把知识库变成稳定的数据输入。如果同一批文件每次读出来的顺序、路径或内容编码都不一致，后面的 chunk id、embedding 缓存和向量库都会跟着变化。

这里最关键的是 `source`。它不是普通显示字段，而是后面 chunk id 的前缀，也是排查命中来源时看到的文件名。`source` 应该满足三个条件：

- 相对路径：不要把本机绝对路径写进向量库。
- POSIX 风格：统一用 `/`，避免 Windows 和 Unix 路径差异。
- 顺序稳定：文件列表排序后再读取，保证同一知识库生成相同 chunk 顺序。

这一章的代码只做读取，不做解析、切块和 embedding。边界越清楚，后面排查问题越容易。

把读取和切块分开还有一个现实好处：将来支持 PDF、HTML、DOCX 时，只需要新增解析器，让它们也输出 `{ source, content }`。后面的 chunking、embedding、retrieval 都不需要知道原始文件格式。

## 目标行为

读取要满足几个稳定性要求，否则后面 chunk 的 `id` 会跟着乱：

- 递归读取子目录。
- 只收指定扩展名，默认 `.md` 和 `.txt`。
- 按文件路径排序，保证导入顺序稳定。
- `source` 用相对路径，并统一成 POSIX 风格（`/` 分隔），避免 Windows / Unix 差异。

## 实现

新建 `documents.ts`：

```ts
// documents.ts
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SourceDocument } from './types';

const DEFAULT_EXTENSIONS = ['.md', '.txt'];

export async function loadDocuments(
  dir: string,
  extensions: readonly string[] = DEFAULT_EXTENSIONS,
): Promise<SourceDocument[]> {
  const files = await walk(dir);
  const matched = files
    .filter((file) => extensions.some((ext) => file.endsWith(ext)))
    .sort();

  const docs: SourceDocument[] = [];
  for (const file of matched) {
    const content = await readFile(file, 'utf8');
    docs.push({ source: toPosix(relative(dir, file)), content });
  }
  return docs;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}
```

## 为什么 source 要规范化

`source` 不只是显示用，它会成为 chunk `id` 的前缀（下一章会看到 `faq.md#0` 这种 id）。如果同一份文档在 Windows 上读成 `sub\faq.md`、在 Linux 上读成 `sub/faq.md`，那么两边生成的向量库 `id` 就不一致，缓存复用和增量导入都会失效。统一成 POSIX 相对路径，结果就和操作系统无关。

:::caution[别把绝对路径写进向量库]
`source` 一定要用**相对路径**且统一成 `/` 分隔。如果写成 `/Users/you/project/documents/faq.md` 这样的本机绝对路径，向量库换台机器就对不上，chunk id 也会跟着变，增量缓存全部失效。规范化 `source` 看似小事，却是“同一份资料在任何机器上生成同一个向量库”的前提。
:::

真实项目还会继续处理几类输入问题：忽略隐藏目录、过滤超大文件、处理不同编码、跳过生成产物、记录读取失败的文件。`mini-rag` 先保留最小实现，因为本章重点是稳定的 `source` 和可重复的读取顺序。

## 验证

准备两份测试文档：

```bash
mkdir -p documents/sub
printf '# 订单问题\n\n## 取消订单\n\n订单支付后 10 分钟内可取消。\n' > documents/faq.md
printf '# 售后规则\n\n7 天无理由退货。\n' > documents/sub/policy.md
```

在 `main.ts` 里调用：

```ts
// main.ts
import { loadDocuments } from './documents';

const docs = await loadDocuments('./documents');
for (const doc of docs) {
  console.log(`${doc.source}  (${doc.content.length} 字符)`);
}
```

运行：

```bash
npm run dev
```

预期输出（注意排序稳定、子目录用 `/` 分隔）：

```text
faq.md  (32 字符)
sub/policy.md  (20 字符)
```

文档已经读进内存。但整篇文档不适合直接 embedding——下一章把它切成语义片段。

这一章之后，知识库从“目录里的文件”变成了“有来源的文本数组”。这一步没有模型参与，却决定了后面所有结果能否被解释：命中来自哪个文件、为什么缓存没有复用、同一份文档在不同机器上 id 是否一致，答案都在这里。

## 本章小结

- `loadDocuments()` 把一个目录递归读成 `SourceDocument[]`，只收指定扩展名、按路径排序。
- 关键字段是 `source`：它要满足**相对路径、POSIX 风格、顺序稳定**三个条件。
- 读取和切块分开，未来支持 PDF / HTML 只需新增解析器输出 `{ source, content }`，后续流程不变。
- 稳定的读取是 chunk id、embedding 缓存、命中回查的共同地基。

:::note[下一章：B04 语义切块与 ChunkRecord]
有了稳定的 `SourceDocument`，下一章把整篇文档切成带标题路径的 `ChunkRecord`。切块直接决定检索的“粒度”，是召回质量的上限所在。
:::
