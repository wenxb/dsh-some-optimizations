# dsh-llm-callid-normalizer

DeepSeek Harness（DSH）插件：把中转伪造的 tool-call id（如 Kimi 系的 `read:0`）在 SSE 流上改写为全局唯一 id，从根上杜绝「历史加载失败：conversation Context … received more than one start Match」和会话中途不再显示的问题。

## 问题

部分 OpenAI 兼容中转在协议转换时按 `<工具名>:<流内序号>` 现造 tool_call id。每次模型响应序号都从 0 重来，于是同一会话日志里出现大量重复 callId；DSH 客户端回放按 callId 全局分区，撞到第二个 start 即中止，表现为：

- 打开历史报「历史加载失败」
- 中途切换到这类模型后，跑一会儿后续消息不再显示（数据其实都在盘上）

## 原理

与 dsh-llm-agentrouter 的 fence 同一手法：经 `ctx.effect()` 包装全局 `fetch`（卸载即还原），仅对成功的 `text/event-stream` 响应体做逐行改写——

- 命中 `<工具名>:<序号>` 模式或空 id：一律重写为 `<原id>#<序号>-<启动标签>`；进程内单调、跨重启靠随机标签分区，永不碰撞
- 其他 id（UUID / `call_*` / `toolu_*` 等）逐字节透传，不影响 provider 内部按 id 关联的签名映射
- openai-completions 与 anthropic-messages 两种线协议均覆盖；SSE 分帧、`\r\n`、注释行、`[DONE]` 原样保留
- 请求方向永不修改：日志里已归一的 id 回传模型时配对关系由构造保证

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-llm-callid-normalizer
# 或发布后：
dsh plugin --profile web add dsh-llm-callid-normalizer
```

重启 `dsh web` 生效。设置 → 插件 出现配置卡片。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `hosts` | `[]` | 仅拦截这些 URL host（如 `127.0.0.1:8601`）；空 = 全部 |
| `announce` | `true` | 启动时打一条日志 |

## 测试

```sh
npm test   # node --test tests/
```

## 已知边界

- 只处理流式响应（harness 的 LLM 请求恒为流式）
- 进程内计数器重启归零，但启动标签保证新旧日志的改写 id 不冲突
