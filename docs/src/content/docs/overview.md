---
title: 概览
description: 用 tiny-rag 作为示例，理解一个轻量级 RAG 系统的能力边界、源码目录和学习路线。
---

## 这是什么

这里以 `tiny-rag` 作为示例项目，拆解一个轻量级 TypeScript RAG 内核如何工作。它的目标不是替代生产级向量数据库，而是把 RAG 的主链路压到一个可以完整读懂、可以本地运行、也可以继续扩展的代码规模里。

核心链路是：

```text
文档目录
  -> 读取 Markdown / TXT
  -> 按标题和段落切块
  -> 调用 embedding 服务
  -> 写入 vector-store.ndjson
  -> 查询时生成问题向量
  -> 向量 + keyword/BM25 混合排序
  -> 拼接上下文
  -> 调用聊天模型回答
```

## 能力范围

当前项目已经实现了这些能力：

- 递归读取本地 `.md` / `.txt` 文档。
- 按 Markdown 标题路径和段落语义切块，长段落才按长度兜底切分。
- 生成 chunk 的内容 hash，复用旧向量，减少重复 embedding 请求。
- 使用 NDJSON 作为本地向量库，不依赖数据库。
- 读取向量库时校验 schema、provider、model、dim 和 chunk 参数。
- 查询时支持向量相似度、中文友好的关键词分词、BM25 标题加权。
- 同一 source 的命中片段有数量限制，避免 TopK 被一个文件占满。
- 支持 LM Studio、Ollama、OpenAI 兼容接口和 DeepSeek 聊天模型。
- 同时提供 CLI、HTTP 服务和库 API。

## 不是什么

它刻意没有做这些事：

- 没有接入外部向量数据库。
- 没有实现复杂 reranker。
- 没有多租户、权限、审计、后台管理。
- 没有把文档导入、查询和服务部署包装成一个完整 SaaS。

这些不是缺陷，而是学习项目的取舍。你能在较小范围内看清每个模块，之后再决定扩展到哪一层。

## 源码目录

```text
src/
  constants/    默认常量和 schema 版本
  ingestion/    文档读取、语义切块、导入向量库
  providers/    embedding/chat 模型服务适配（含 runtime.ts 解析运行时参数）
  query/        检索、Prompt、问答编排
  storage/      NDJSON 向量库读写和中间缓存
  utils/        hash、并发、向量、JSON、校验等通用工具
cli.ts          本地命令行入口
serve.ts        HTTP 服务入口
test/           单元测试和库 API 测试
```

环境变量的读取并不在 `src/` 里，而是在 `cli.ts` 和 `serve.ts` 这两个入口文件中完成。`src/` 只接收显式配置，这条边界是整个项目可测试、可复用的基础。

## 怎么读这份文档

这份文档不是从 `src/index.ts` 的导出列表开始逐个 API 讲解，而是带你**从零搭一个简化版 RAG**，再回头对照 tiny-rag 真实源码理解工程取舍：

1. **认识**：先建立项目边界（本章）和架构全景。
2. **从零构建**：跟着 `B01` 到 `B10`，一章一个里程碑。每章只引入一组关键概念，再写能运行的代码。
3. **工程化**：理解 CLI / HTTP / 库 API 三种入口，以及配置与调参。
4. **优化与扩展**：看 tiny-rag 在简化版之上做了哪些优化，以及未来的 TODO。

## 学习目标

读完这份文档后，你应该能回答这些问题：

- 修改资料后为什么要重新 `ingest`？
- 为什么换 embedding 模型必须重建向量库？
- `CHUNK_SIZE`、`TOP_K`、`MIN_SCORE`、`KEYWORD_WEIGHT` 分别影响什么？
- 为什么查询服务会先 `createRetriever()`，再处理 `/query`？
- tiny-rag 相比最简实现多做了哪些优化？
- 如果要加 reranker、接入向量数据库、支持 PDF，应该改哪些模块？
