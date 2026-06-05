---
title: 权限与 RAG 安全
description: 解释 Prompt 不是访问控制，权限过滤必须发生在 retrieval 前，并梳理多用户、日志和工具调用的安全边界。
---

B10 已经讲了 Prompt 注入：参考内容是不可信文本，不能让文档里的指令覆盖 system 规则。但真正的团队或公网服务还需要更强的权限和安全边界。

> **扩展落点**：权限过滤在 retrieval 前；鉴权、限流、审计在 serve 层；Prompt 只做最后约束。

:::note[本章目标]
读完这一章，你应该能说清为什么 Prompt 不是访问控制，权限过滤应该放在哪里，以及多用户 RAG 服务最少要补哪些安全能力。
:::

## Prompt 不是权限系统

不要把无权资料放进 context，然后指望模型“不说出来”。

```text
错误做法：
  检索全库 -> 把无权 chunk 放进 context -> Prompt 写“不要回答无权内容”

正确做法：
  根据用户身份过滤可见 chunk -> 只检索有权资料 -> buildContext()
```

模型不是可靠的访问控制层。无权 chunk 只要进入 Prompt，就已经泄漏给模型和日志系统。

## 权限过滤位置

权限应该尽量发生在 retrieval 前：

```text
request user
  -> auth
  -> resolve allowed scopes
  -> filter retrievable chunks
  -> vector / keyword search
  -> hits
  -> context
```

如果接入向量数据库，权限可以变成 metadata filter：

```text
collection.search(
  queryEmbedding,
  filter: { tenantId, allowedGroups }
)
```

如果仍用本地向量库，就需要在检索前或打分时跳过无权记录。

## 多租户隔离

多用户系统至少要区分：

- `tenantId`：租户或组织。
- `userId`：用户。
- `groups` / `roles`：用户可见范围。
- `knowledgeBaseId`：知识库边界。

不要把所有用户的文档放在一个无过滤的全局 retriever 里。即使 Prompt 做了约束，候选列表、日志和调试接口也可能泄漏 source 或 content。

## 会话记忆隔离

多轮对话还要隔离 memory。

```text
session memory key = tenantId + userId + sessionId
```

不要使用全局历史窗口。否则用户 A 的历史可能进入用户 B 的 Prompt，轻则串话，重则泄漏资料。

历史消息也不能覆盖当前检索证据。多轮对话里，历史只能帮助理解问题，不能替代本轮 `hits`。

## 日志与审计

RAG 服务很容易把敏感信息写进日志：

- 用户问题。
- 命中 source。
- context 正文。
- 模型回答。
- provider 错误响应。

团队使用时至少要考虑：

| 能力 | 作用 |
| --- | --- |
| 请求审计 | 谁问了什么、命中了哪些 source |
| 日志脱敏 | 避免泄漏隐私、密钥、客户数据 |
| 保留期限 | 日志不能无限保存 |
| 管理员访问控制 | 不是所有人都能看 query 日志 |

调试时 `includeContext` 很有用，但在公网或团队服务里要谨慎开放。

## 工具调用安全

如果未来加工具调用，要区分只读工具和写操作工具：

| 工具类型 | 例子 | 要求 |
| --- | --- | --- |
| 只读 | 查订单状态、查时间 | 权限校验、结果脱敏 |
| 写操作 | 退款、取消订单、发邮件 | 人类确认、审计、幂等保护 |

工具输出也应该像检索 context 一样被当作资料，不能改写 system 规则。

## 最小安全清单

| 场景 | 最少要做 |
| --- | --- |
| 本机学习 | 默认 localhost 即可 |
| 局域网共享 | `SERVE_AUTH_TOKEN` + 并发限制 |
| 团队知识库 | 用户身份、知识库权限、审计日志 |
| 多租户 | tenant 隔离、metadata filter、日志脱敏 |
| 外部动作工具 | 权限校验、人类确认、审计 |

## 本章小结

- Prompt 注入防护是必要的，但它不是访问控制。
- 无权 chunk 不应该进入 candidates，更不应该进入 context。
- 权限过滤尽量放在 retrieval 前，向量数据库可用 metadata filter 实现。
- 多用户系统要隔离知识库、会话记忆和日志访问。
- 工具调用尤其是写操作，需要权限、确认和审计。

:::note[继续阅读]
B10 讲的是 Prompt 层的安全边界；这一章补的是架构层权限。两者都需要，但不能互相替代。
:::
