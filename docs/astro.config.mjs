import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://wsafight.github.io',
  base: '/tiny-rag',
  integrations: [
    starlight({
      title: 'RAG 如何工作',
      description: '从零实现 mini-rag，理解 RAG 如何完成文档导入、语义切块、向量库、混合检索、Prompt 问答、CLI 和 HTTP 服务，再对照 tiny-rag 源码看工程取舍。',
      locales: {
        root: {
          label: '简体中文',
          lang: 'zh-CN',
        },
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/wsafight/tiny-rag',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: '理解 RAG 系统',
          items: [
            { label: 'RAG 项目概览', slug: 'overview' },
            { label: '工作流与源码架构', slug: 'architecture' },
          ],
        },
        {
          label: '从零实现 mini-rag',
          items: [
            { label: 'B01: 项目骨架与核心类型', slug: 'build-01-skeleton' },
            { label: 'B02: 模型抽象与 Provider', slug: 'build-02-providers' },
            { label: 'B03: 文档读取与 source', slug: 'build-03-documents' },
            { label: 'B04: 语义切块与 ChunkRecord', slug: 'build-04-chunking' },
            { label: 'B05: Embedding 与向量写入', slug: 'build-05-store' },
            { label: 'B06: 向量库读取与 ingest', slug: 'build-06-ingest' },
            { label: 'B07: 纯向量检索与 TopK', slug: 'build-07-retrieval' },
            { label: 'B08: 关键词分词与 BM25', slug: 'build-08-keyword-bm25' },
            { label: 'B09: 混合检索与同源去重', slug: 'build-09-hybrid' },
            { label: 'B10: Prompt 与端到端问答', slug: 'build-10-prompt-query' },
          ],
        },
        {
          label: '工程化接入',
          items: [
            { label: '三种入口：CLI / HTTP / 库 API', slug: 'interfaces' },
            { label: '配置与检索调参', slug: 'config-tuning' },
          ],
        },
        {
          label: '诊断与速查',
          items: [
            { label: '诊断与解析方法', slug: 'diagnostics' },
            { label: '核心术语速查', slug: 'glossary' },
          ],
        },
        {
          label: '优化与扩展',
          items: [
            { label: '工程优化如何工作', slug: 'optimizations' },
            { label: '后续扩展路线', slug: 'roadmap' },
          ],
        },
      ],
    }),
  ],
});
