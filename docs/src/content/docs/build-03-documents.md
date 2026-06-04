---
title: "B03: 文档读取与 source"
description: 递归读取 .md / .txt，生成可移植的 POSIX source 路径。
---

骨架和模型抽象立好后，第一段真实数据是磁盘上的文档。这一章实现 `loadDocuments()`，把一个目录里的 `.md` / `.txt` 读成 `SourceDocument[]`。

## 先理解：读取文档要稳定可重复

RAG 的第一步不是调用模型，而是把知识库变成稳定的数据输入。如果同一批文件每次读出来的顺序、路径或内容编码都不一致，后面的 chunk id、embedding 缓存和向量库都会跟着变化。

这里最关键的是 `source`。它不是普通显示字段，而是后面 chunk id 的前缀，也是排查命中来源时看到的文件名。`source` 应该满足三个条件：

- 相对路径：不要把本机绝对路径写进向量库。
- POSIX 风格：统一用 `/`，避免 Windows 和 Unix 路径差异。
- 顺序稳定：文件列表排序后再读取，保证同一知识库生成相同 chunk 顺序。

这一章的代码只做读取，不做解析、切块和 embedding。边界越清楚，后面排查问题越容易。

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
