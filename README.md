# dsh-some-optimizations

一些优化 —— DeepSeek Harness(DSH)插件,一组可单独开关的个人 LLM 链路修复。

## 开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `normalizeCallIds` | 开 | 流内改写中转伪造的 tool-call id(如 Kimi 系 `read:0`),杜绝「历史加载失败:received more than one start Match」与会话中途不再显示 |
| `unboundedStreamTimeouts` | 开 | 解除 Node/undici 300s 流式空闲超时——中转长思考/预填充期间零字节转发导致的「Stream ended without finish_reason」 |
| `bodyTimeoutMs` / `headersTimeoutMs` | 0 | 上两项启用时的超时值;0 = 彻底禁用 |
| `projCacheGc` | 开 | 投影缓存孤儿行回收:定期删除 `session_projcache` 里已无对应持久化日志的检查点行(官方 projection-cache 无淘汰接口,孤儿行随会话增删无限累积;而该域每次行更新都全量重写 JSON,膨胀后就是持续 iowait) |
| `projCacheGcIntervalMs` | 3600000 | 上一项的回收节奏毫秒(下限 60s);启动宽限 60s 后先跑一轮 |
| `imageShed` | 开 | 滚动清图:表面上只保留最新 N 张图片,更老的立即替换为带名称/尺寸/哈希线索的文本占位符(治历史截图无限累积撑爆请求体——NIM 约 7-8MiB 就拒收) |
| `imageShedKeepLatest` | 2 | 上一项保留的最新图片张数;0 = 见一张杀一张 |
| `hosts` | `[]` | 仅对指定 host 生效(如 `127.0.0.1:8601`);空 = 全部(仅影响 fetch 改写两项) |

## Web 设置入口

**设置 → 插件** 页有「DSH 优化」折叠卡片,内含五个开关(tool-call id
归一化 / 解除流式超时 / 投影缓存回收 / 滚动清图),改动即时保存。原理:官方 settings 线协议(describe/mutate)
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

### image-shed(滚动清图,表面侧)

背景:官方压缩只摘要文本、图片零成本永不清理(见 f99704f5 会话字节级复现:
NIM 对请求体有 ~7-8MiB 硬墙,9 张历史截图 ≈7.6MB base64 内联后直接撞墙
返回 "Internal server error")。而压缩可能十几小时才落地一次,期间截图照样堆爆。

做法(不依赖压缩节奏,表面常驻守卫):

- 触发:表面上追加消息事件、或任何引擎的 compaction/summary 落地
  (微任务延迟避开 append 重入窗口);同轮多次触发按会话合并
- 策略:全表面只保留最新 `imageShedKeepLatest` 张图片块(attachment 引用
  与内联 base64 都算),更老的替换为带名称/尺寸/哈希线索的文本占位符;
  同一事件里只去掉超额旧图,兄弟新图原样保留(部分替换)
- 协议:照抄宿主 dsh-compaction-tool-result-pruner 的持久化替换
  (`compaction/prune` 影子价目 + 同类型 replace 事件 + surfaceOp/sourceEventSeqs),
  消息壳与 tool-call/result 配对全部不动
- 对账:claim 按被替换原节点完整宿主价计(fold 公式 delta=新价−claim),
  优先活体 tokenMeter、缺失回落本地 flat-4 镜像;每轮至多 measure 一次
- 护栏:表面尾 seq + 配置指纹未变则整轮跳过;幂等(占位符是 text 块,
  再扫不到图);异常只 warn 不阻塞

### projcache-gc(投影缓存孤儿行回收,存储侧)

背景:`@deepseek-ai/dsh-session-projection-cache` 把每个会话的投影检查点写成
`~/.dsh/storages/session_projcache.json` 的一行(`tables.sessions.<id>`),其
README「已知局限」明说**不提供淘汰接口**——记录按会话持续累积。而该域的 json
后端每次行更新都会**全量重写整个文件**:实测一个 50MB 的缓存(大量已删会话的
孤儿行)让一块健康 SATA SSD 长期 77% 忙碌、系统 iowait 12~20%,全机卡顿。

做法:

- 句柄:`storageDomain.get('session_projcache')` 拿**共享打开句柄**
  (DomainFacility 对每域名强制 single-open,get 是官方诊断面)——删除走的是
  projection-cache 正在用的同一个运行态,不绕过、不复制任何内部状态
- 判据:`sessionPersistence.list()` 的存活 id 集 vs 缓存表 keys 的差集;
  `table.delete(id)` 逐行删除
- 护栏:list 失败整轮跳过;list 为空而缓存非空视为基线异常同样跳过——
  宁可不删,不误伤全场。域未挂载时静默等下一轮
- 语义安全:官方契约「缓存行绝不当权威」(可能陈旧但绝不会错),删行的唯一
  代价是下次冷读多回放一段日志,与宿主 fail-soft 方向一致

## 测试

```sh
npm test
```
