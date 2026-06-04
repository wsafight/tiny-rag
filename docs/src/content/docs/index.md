---
title: RAG 是怎样工作的
description: 从文档导入到检索问答，理解一个轻量级 TypeScript RAG 系统如何工作。
template: splash
tableOfContents: false
hero:
  title: RAG 是怎样工作的
  tagline: 从零搭一个简化版 RAG，跑通文档导入、语义切块、向量库、混合检索到 Prompt 编排，再对照 tiny-rag 源码理解工程取舍。
  image:
    html: |
      <div class="hero-flow" aria-hidden="true">
        <div class="hero-flow__row">
          <span>docs</span>
          <span>chunk</span>
        </div>
        <div class="hero-flow__row">
          <span>embed</span>
          <span>store</span>
        </div>
        <div class="hero-flow__row hero-flow__row--wide">
          <span>retrieve</span>
          <span>answer</span>
        </div>
      </div>
  actions:
    - text: 开始学习
      link: /tiny-rag/overview/
      icon: right-arrow
    - text: 架构全景
      link: /tiny-rag/architecture/
      icon: open-book
      variant: secondary
---

## 学习路径

<div class="source-map landing-map">
  <a href="/tiny-rag/overview/">
    <strong>理解 RAG 系统</strong>
    <span>先建立 RAG 项目边界和工作流全景，知道每个模块的职责。</span>
  </a>
  <a href="/tiny-rag/build-01-skeleton/">
    <strong>从零构建 mini-rag</strong>
    <span>B01-B10 一章一个里程碑，每章只引入一组关键概念，再写能运行的代码。</span>
  </a>
  <a href="/tiny-rag/optimizations/">
    <strong>优化与扩展</strong>
    <span>看真实源码在简化版之上做的工程优化，以及未来的扩展路线。</span>
  </a>
</div>

## 源码主线

<div class="pipeline landing-pipeline">
  <span>documents</span>
  <span>chunk</span>
  <span>embedding</span>
  <span>vector store</span>
  <span>retrieval</span>
  <span>LLM answer</span>
</div>

这套文档不从导出列表逐个讲 API，而是带你从零搭一个简化版 `mini-rag`，跑通同一条主链路，再回头对照 tiny-rag 真实源码理解工程取舍。

## 快速入口

1. [概览](/tiny-rag/overview/)：建立项目边界和源码地图。
2. [架构全景](/tiny-rag/architecture/)：先看导入链路、查询链路和运行入口。
3. [B01: 项目骨架与核心类型](/tiny-rag/build-01-skeleton/)：从零开始写 mini-rag。

基于当前 `tiny-rag` 源码整理，把它作为理解 RAG 工作原理的示例项目。
