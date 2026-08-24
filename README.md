# dsh-some-optimizations

一些优化 —— DeepSeek Harness(DSH)插件,一组可单独开关的个人 LLM 链路修复。

## 开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `normalizeCallIds` | 开 | 流内改写中转伪造的 tool-call id(如 Kimi 系 `read:0`),杜绝「历史加载失败:received more than one start Match」与会话中途不再显示 |
| `unboundedStreamTimeouts` | 开 | 解除 Node/undici 300s 流式空闲超时——中转长思考/预填充期间零字节转发导致的「Stream ended without finish_reason」 |
| `bodyTimeoutMs` / `headersTimeoutMs` | 0 | 上两项启用时的超时值;0 = 彻底禁用 |
| `modelPin` | 开 | 模型钉死(按会话):在某个会话里点选模型后,该会话之后的所有请求都强制走所选模型,无视任何中间层改写;其他会话不受影响 |
| `hosts` | `[]` | 仅对指定 host 生效(如 `127.0.0.1:8601`);空 = 全部(仅影响前两项 fetch 改写;模型钉死与 host 无关) |

## Web 设置入口

**设置 → 插件** 页有「DSH 优化」折叠卡片,内含三个开关(模型钉死 / tool-call id
归一化 / 解除流式超时),改动即时保存。原理:官方 settings 线协议(describe/mutate)
只服务 apiproxy 白名单 namespace,第三方插件不在列;官方「插件」页又只渲染
「host 服务 ∩ 客户端卡片认领」的交集。所以本插件照 dsh-better-retry 的成熟模式自建:

- 服务端注册 settings namespace(热更)+ 同源路由 `/dsh-some-optimizations/config`
  (GET 读、POST `{patch}` 写,schema 校验后走 `settings.update`)
- 浏览器端经 package.json 的 `dsh.client` 声明注入 `/plugins/<id>/client.js`,
  往 `settings.plugin.item` slot 认领卡片(key=`some-optimizations`)

`hosts` 与超时数值仍走 cordis entry config(patch yml)。

## 原理

fetch 类(与 agentrouter fence 同款手法,经 `ctx.effect()` 可逆安装):

- id 归一化:仅拦截成功 SSE 响应,逐行改写,分帧/CRLF/注释/[DONE] 原样保留;首见 `<名>:<序号>` 改写为 `<原id>#<序号>-<启动标签>`,进程内单调、跨重启分区,永不碰撞
- 超时加固:undici 共享全局注册表是内置 fetch 唯一认的旋钮,安装期替换 dispatcher、卸载还原(实测 per-request 注入外部 Agent 会死锁)

请求方向除 dispatcher 外不做任何改写。

### model-pin(模型钉死,会话作用域)

背景:官方链路里 UI 点选只写入 api-proxy 内一个 per-agent 进程变量,每个 step 经
`agent/request` waterfall 组装最终 config。该变量存在被未知路径静默改写的实例
(实测发生过:turn 错误结束后下一轮请求回到了旧模型)。

做法(自维护「哪个会话点了什么」,不依赖全局 settings):

- 采集:浏览器端包一层 `window.fetch`,旁观到 `session.selectModel` rpc
  (含 sessionId/provider/model/reasoningEffort)就 POST 宿主
  `/dsh-some-optimizations/click`;纯观察,原调用原样透传
- 存储:`~/.dsh/some-optimizations-pins.json`(原子写),sessionId → 选择,
  LRU 截断 100 条
- 身份:agentEvents 把 agent 融进每个事件 payload(dsh-agent `fused`),
  全局监听里 `payload.agent.session.id` 即会话 id;拿不到身份一律放行
- 生效点:插件启动时注册全局 `ctx.on("agent/request", ...)`,cordis waterfall
  语义(先注册者=最外层=返回值说了算)保证本监听位于所有内层覆盖之外,
  `await next()` 后按会话查表改写即最后一锤定音
- 语义:路由不同才接管;接管时清除继承的 reasoningEffort(所选带 effort 则
  显式下发),与官方 installModelSelection 行为一致;同路由零动作

注意:钉子只命中发生点选的那个会话(子代理若共享同一 sessionId 同样生效);
标题生成等非 agent 链路不走该 waterfall,天然不受影响。删除 pins 文件即清空
全部钉子。

## 测试

```sh
npm test
```
