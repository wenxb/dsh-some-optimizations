# dsh-some-optimizations

一些优化 —— DeepSeek Harness(DSH)插件,一组可单独开关的个人 LLM 链路修复。

## 开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `normalizeCallIds` | 开 | 流内改写中转伪造的 tool-call id(如 Kimi 系 `read:0`),杜绝「历史加载失败:received more than one start Match」与会话中途不再显示 |
| `unboundedStreamTimeouts` | 开 | 解除 Node/undici 300s 流式空闲超时——中转长思考/预填充期间零字节转发导致的「Stream ended without finish_reason」 |
| `bodyTimeoutMs` / `headersTimeoutMs` | 0 | 上两项启用时的超时值;0 = 彻底禁用 |
| `hosts` | `[]` | 仅对指定 host 生效(如 `127.0.0.1:8601`);空 = 全部 |

设置面存在时在 设置 → 插件 出现卡片;否则直接改 `cordis.patch.yml` 的 entry config。

## 原理

都挂在全局 fetch 缝隙(与 agentrouter fence 同款手法,经 `ctx.effect()` 可逆安装):

- id 归一化:仅拦截成功 SSE 响应,逐行改写,分帧/CRLF/注释/[DONE] 原样保留;首见 `<名>:<序号>` 改写为 `<原id>#<序号>-<启动标签>`,进程内单调、跨重启分区,永不碰撞
- 超时加固:undici 共享全局注册表是内置 fetch 唯一认的旋钮,安装期替换 dispatcher、卸载还原(实测 per-request 注入外部 Agent 会死锁)

请求方向除 dispatcher 外不做任何改写。

## 测试

```sh
npm test
```
