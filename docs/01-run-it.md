# 第一步：先把 Tiny RAG 跑起来

这一步不讲太多概念，只让你先看到项目真的能完成一次“导入知识库 -> 提问 -> 回答”。

## 你要先知道三个目录

- `my-notes/`：业务知识库。现在里面放的是青橙咖啡的示例业务规则。
- `docs/`：学习文档。你正在看的就是学习文档，不会被默认导入。
- `vector-store.ndjson`：运行导入命令后生成的本地向量库（NDJSON 格式）。

## 1. 安装依赖

在项目根目录运行：

```bash
npm install
```

如果已经安装过，可以跳过。

## 2. 准备环境变量

复制配置模板：

```bash
cp .env.example .env
```

默认配置会导入：

```text
DOCUMENTS_DIR=./my-notes
```

这表示 RAG 会学习 `my-notes/` 里的业务资料，而不是学习 `docs/` 里的教程。

## 3. 启动一个模型服务

你需要一个可以提供 embedding 和 chat 的模型服务。任选一种方式即可。

### 方式 A：LM Studio

启动 LM Studio 的本地 server，确认地址是：

```text
http://127.0.0.1:1234/v1
```

`.env` 默认使用 LM Studio：

```text
LLM_PROVIDER=lmstudio
EMBEDDING_PROVIDER=lmstudio
```

同时要确认 LM Studio 里加载了一个聊天模型和一个 embedding 模型。模型名要和 `.env` 中的 `LMSTUDIO_LLM_MODEL`、`LMSTUDIO_EMBEDDING_MODEL` 一致。

### 方式 B：Ollama

如果你用 Ollama，把 `.env` 改成：

```text
LLM_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
```

并准备模型：

```bash
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

### 方式 C：OpenAI 或兼容 API

如果你用 OpenAI 或兼容服务，把 `.env` 改成：

```text
LLM_PROVIDER=openai
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=你的 API Key
```

## 4. 导入业务知识库

运行：

```bash
npm run ingest
```

你应该看到类似输出：

```text
[ingest] 共加载 N 个文档
[ingest] 切块数量: ...
[ingest] 向量库已写入 ./vector-store.ndjson
```

这一步做的事情是：读取 `my-notes/`，把每段文字变成向量，然后保存到 `vector-store.ndjson`。

## 5. 提一个业务问题

运行：

```bash
npm run query -- "会员生日券怎么使用？"
```

你会先看到检索表格：

```text
Retrieved Context (top 4)
-------------------------
  #  score   chunk  source                  heading
  1  0.8123  2      my-notes/membership.md  会员与优惠规则 > 生日券
```

这表示系统先从知识库里找到了最相关的资料。然后你会看到模型基于这些资料生成的回答。

## 6. 再试几个问题

```bash
npm run query -- "订单支付后还能改地址吗？"
npm run query -- "企业团购需要提前多久预约？"
npm run query -- "饮品做好后可以保留多久？"
```

如果问题答案在 `my-notes/` 里，模型应该能回答并引用资料编号。如果资料里没有答案，模型应该回答不知道。

## 7. 如果看到报错

第一次运行时，常见错误通常来自三类地方：

- 模型服务没启动：先确认 LM Studio / Ollama / API 地址可以访问。
- `.env` 写错：比如 `TOP_K=abc`、`STREAM=maybe`，脚本会直接指出哪个变量不合法。
- 换了 embedding 模型：重新运行 `npm run ingest`，让 `vector-store.ndjson` 和当前模型保持一致。

如果你只改了聊天模型，不需要重新导入；如果改了 embedding 模型，就需要重新导入。

## 8. 现在你已经跑通了什么

你刚刚跑通的是 RAG 的完整最小流程：

```text
业务文档 -> 生成向量库 -> 用户提问 -> 检索相关片段 -> 大模型基于片段回答
```

下一篇看 `docs/02-what-happened.md`，再理解每一步为什么要这样做。


换 embedding 模型 到 text-embedding-3-large （你 .env 里其实有配 OpenAI 那一组）或国产中文专用 embedding（如 bge-large-zh ）