# 第二步：刚才到底发生了什么

你运行了两个命令：

```bash
npm run ingest
npm run query -- "会员生日券怎么使用？"
```

这两个命令分别对应 RAG 的两个阶段：导入阶段和查询阶段。

## 导入阶段

导入阶段由 `src/ingest.js` 完成。

它做了四件事：

1. 读取 `my-notes/` 里的 Markdown 文档。
2. 把长文本切成较小的 chunk。
3. 调用 embedding 模型，把每个 chunk 变成一组数字。
4. 把 chunk、来源文件和向量按 NDJSON 格式写入 `vector-store.ndjson`（第一行是元数据，之后每行一条 chunk）。

每次运行 `npm run ingest` 都会重新生成向量库文件，而不是在旧文件后面继续追加。这样可以避免你删掉或修改了业务资料后，旧资料还残留在检索结果里。

为什么要切块？因为用户通常只问一个具体问题，不需要把整份文档都塞给模型。切成小块后，系统可以只找最相关的几段资料。

## 什么是 embedding

embedding 可以先理解成“把一句话转换成语义坐标”。

例如：

```text
会员生日券怎么用？
生日饮品券有效期多久？
```

这两句话字面不同，但语义接近。embedding 的作用是让系统能按语义相似度找资料，而不只是匹配关键词。

## 查询阶段

查询阶段由 `src/query.js` 完成。

它做了五件事：

1. 读取你的问题。
2. 把问题也转换成 embedding。
3. 用 cosine similarity 比较问题和所有 chunk 的相似度。
4. 取分数最高的几个 chunk。
5. 把这些 chunk 放进 prompt，让大模型回答。

所以 RAG 不是让模型凭记忆回答，而是先帮模型找资料。

## 检索结果是什么

查询时你会看到：

```text
Retrieved Context (top 4)
-------------------------
  #  score   chunk  source                  heading
  1  0.8123  2      my-notes/membership.md  会员与优惠规则 > 生日券
```

这表示第 1 个召回片段来自 `my-notes/membership.md` 的某个 chunk，相似度分数是 0.8123。

如果检索结果找错了，最终答案通常也会错。排查 RAG 问题时，先看检索结果，再看模型回答。

## RAG 的关键边界

RAG 只能回答知识库里有依据的问题。

如果你问“青橙咖啡 CEO 是谁”，而 `my-notes/` 没写这个信息，正确回答应该是“不知道”。这不是失败，而是 RAG 可靠性的要求。
