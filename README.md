# dsh-some-optimizations

一些优化 —— DeepSeek Harness(DSH)插件,一组可单独开关的个人 LLM 链路修复。

## 开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `normalizeCallIds` | 开 | 流内改写中转伪造的 tool-call id(如 Kimi 系 `read:0`),杜绝「历史加载失败:received more than one start Match」与会话中途不再显示 |
| `unboundedStreamTimeouts` | 开 | 解除 Node/undici 300s 流式空闲超时——中转长思考/预填充期间零字节转发导致的「Stream ended without finish_reason」 |
| `bodyTimeoutMs` / `headersTimeoutMs` | 0 | 上两项启用时的超时值;0 = 彻底禁用 |
| `modelPin` | 开 | 模型钉死:设置里最后点选的模型强制生效于之后**所有**请求,无视任何中间层改写 |
| `hosts` | `[]` | 仅对指定 host 生效(如 `127.0.0.1:8601`);空 = 全部(仅影响前两项 fetch 改写;模型钉死与 host 无关) |

设置面存在时在 设置 → 插件 出现卡片;否则直接改 `cordis.patch.yml` 的 entry config。

## 原理

fetch 类(与 agentrouter fence 同款手法,经 `ctx.effect()` 可逆安装):

- id 归一化:仅拦截成功 SSE 响应,逐行改写,分帧/CRLF/注释/[DONE] 原样保留;首见 `<名>:<序号>` 改写为 `<原id>#<序号>-<启动标签>`,进程内单调、跨重启分区,永不碰撞
- 超时加固:undici 共享全局注册表是内置 fetch 唯一认的旋钮,安装期替换 dispatcher、卸载还原(实测 per-request 注入外部 Agent 会死锁)

请求方向除 dispatcher 外不做任何改写。

### model-pin(模型钉死)

背景:官方链路里 UI 点选只写入 api-proxy 内一个 per-agent 进程变量,每个 step 经
`agent/request` waterfall 组装最终 config。该变量存在被未知路径静默改写的实例
(实测发生过:turn 错误结束后下一轮请求回到了旧模型)。

做法:

- 数据源:`selectModel` 每次都会把选择尽力持久化进 settings 的 `agent-default-model`
  namespace——直接读它即得「用户最后一次点选」,无需自维护状态
- 生效点:插件启动时注册 `ctx.on("agent/request", ...)`,cordis waterfall 语义
  (先注册者=最外层=返回值说了算)保证本监听位于所有内层覆盖之外,
  `await next()` 后改写即最后一锤定音
- 语义:路由不同才接管;接管时清除继承的 reasoningEffort(所选带 effort 则显式下发),
  与官方 installModelSelection 行为一致;同路由零动作
- 回执:点击落盘即刻日志确认(`selection saved -> provider/model`),
  实际接管时再记一条 `providerA -> providerB`

注意:model-pin 是全局钉(所有会话含子代理);标题生成等非 agent 链路不走该
waterfall,天然不受影响。

## 测试

```sh
npm test
```
