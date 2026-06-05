---
title: RAG 如何工作
description: 用一条可运行的 TypeScript 主线，深度拆解 RAG 从文档导入、向量检索到 Prompt 回答的全过程。
template: splash
tableOfContents: false
hero:
  title: RAG 如何工作
  tagline: 从零搭一个简化版 RAG，跑通文档导入、语义切块、向量库、混合检索到 Prompt 编排，再对照 tiny-rag 源码理解工程取舍。
  image:
    html: |
      <div class="hero-flow" aria-hidden="true">
        <div class="hero-flow__row">
          <span>文档</span>
          <span>切块</span>
        </div>
        <div class="hero-flow__row">
          <span>向量化</span>
          <span>入库</span>
        </div>
        <div class="hero-flow__row hero-flow__row--wide">
          <span>检索</span>
          <span>回答</span>
        </div>
      </div>
  actions:
    - text: 开始学习
      link: /tiny-rag/overview/
      icon: right-arrow
    - text: 工作流与源码架构
      link: /tiny-rag/architecture/
      icon: open-book
      variant: secondary
---

## 学习路径

很多 RAG 教程会从一个流程图开始：文档进来，向量出去，最后模型回答。真正写代码时，问题会细很多：chunk 的 `id` 怎么稳定？换 embedding 模型为什么必须重建？BM25 和向量分数怎么合并？HTTP 服务为什么不能每次请求都重新加载向量库？

这套文档把这些问题拆成一组连续文章。你会先读懂一个轻量级 RAG 系统的边界，再从零写出 `mini-rag`，最后回到 tiny-rag 源码看工程优化。每篇都围绕一个具体决策展开：它解决什么问题、简化实现怎么写、真实项目还要补什么。

<div class="source-map landing-map">
  <a href="/tiny-rag/overview/">
    <strong>理解 RAG 系统</strong>
    <span>先建立 RAG 项目边界和工作流全景，知道每个模块的职责。</span>
  </a>
  <a href="/tiny-rag/build-01-skeleton/">
    <strong>从零构建 mini-rag</strong>
    <span>B01-B10 一章一个里程碑，每章只引入一组关键概念，再写能运行的代码。</span>
  </a>
  <a href="/tiny-rag/diagnostics/">
    <strong>诊断一次失败查询</strong>
    <span>用 candidates、hits、score、meta 和耗时字段判断问题落在导入、召回还是生成。</span>
  </a>
  <a href="/tiny-rag/optimizations/">
    <strong>优化与扩展</strong>
    <span>看真实源码在简化版之上做的工程优化，以及未来的扩展路线。</span>
  </a>
</div>

## 源码主线

<div class="pipeline landing-pipeline">
  <span>文档</span>
  <span>切块</span>
  <span>向量化</span>
  <span>向量库</span>
  <span>检索</span>
  <span>生成回答</span>
</div>

这套文档不从导出列表逐个讲 API，而是带你从零搭一个简化版 `mini-rag`，跑通同一条主链路，再回头对照 tiny-rag 真实源码理解工程取舍。

理解 RAG 的关键不是记住某个库的调用方式，而是抓住两条生命周期：

- **导入阶段**：把不稳定的文件系统输入，变成稳定、可校验、可复用的向量库。
- **查询阶段**：把用户问题映射到同一个向量空间，找出片段，再用 Prompt 约束模型回答。

只要这两条线清楚，后面接不同模型、换向量数据库、增加 reranker 或多轮对话，都只是把某个边界替换掉。

## 快速入口

1. [RAG 项目概览](/tiny-rag/overview/)：建立项目边界和源码地图。
2. [工作流与源码架构](/tiny-rag/architecture/)：先看导入链路、查询链路和运行入口。
3. [B01: 项目骨架与核心类型](/tiny-rag/build-01-skeleton/)：从零开始写 mini-rag。
4. [诊断与解析方法](/tiny-rag/diagnostics/)：跑通主线后，用中间结果判断 RAG 问题落在哪一层。

基于当前 `tiny-rag` 源码整理，把它作为理解 RAG 工作原理的示例项目。
