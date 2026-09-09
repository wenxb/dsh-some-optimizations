/**
 * image-shed —— 表面上只保留最新的 N 张图片，更老的替换成文本占位符。
 *
 * 背景（f99704f5 会话字节级复现）：NVIDIA NIM 对请求体有 ~7-8MiB 硬墙
 * （8.4MB → HTTP 200 + SSE 内联 {"error":{"message":"Internal server error",
 * "type":"internal_server_error","code":500}}；6.9MB 通过）。而官方压缩插件族
 * （dsh-compaction-basic / tool-result-pruner）只摘要文本：measureContent 只数
 * text 块，非 text 块原样保留 —— 图片附件零成本、永不清理；billion-context-dsh
 * 的 kernel 同样看不见图片（extractText 跳过非文本块）。历史截图于是无限累积，
 * 每次请求都被 pi-ai 展开成 base64 内联进请求体，直到撞墙。
 *
 * 策略（v2，滚动保留）：不依赖压缩节奏 —— 实测压缩可能十几小时才落地一次，
 * 期间截图照样堆到撞墙。改为在【每次表面追加图片】与【任何引擎的 compaction
 * 落地】时扫描整个表面，只保留最新 `keepLatest` 张（默认 2）图片块（attachment
 * 引用形式与内联 base64 形式都算），其余替换成一行文本占位符。同一事件里若
 * 只需去掉其中一张，其余兄弟图原样保留（部分替换）。
 *
 * 持久化协议照抄宿主自己的 dsh-compaction-tool-result-pruner：
 *   1. 追加 `compaction/prune` 作为影子价目。claim 必须等于被替换原节点的
 *      【完整宿主价】：宿主折叠公式是 delta = 新节点宿主价 − claim
 *      （dsh-token-meter foldSurfaceProjection），部分替换时也只有整节点价
 *      才能对账归零。计数必须说宿主的 flat-4 词汇表——CJK 会话上用 CJK 计数
 *      会透支 meter 把会话永久砖死（billion-context issue #54 / 其 AGENTS.md
 *      rule 12）；优先取活体 tokenMeter.measure 的节点价，缺失回落本地镜像；
 *   2. 追加同类型替换事件（tool/result 就还是 tool/result），内容=原事件壳不变、
 *      仅嵌套 content 数组里的目标图片块换成占位符文本，带
 *      `surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs:[seq]`。
 * 原事件永远留在 append-only 日志里；替换后幂等（占位符是 text 块，再扫不到图）。
 *
 * 安全设计：
 *   - `session.append` 不可重入：监听发生在别人 append 的发布期内，同步
 *     append 会静默失败 —— 必须 queueMicrotask 延迟（billion-context
 *     deferCompressPairHide 的同款教训）；同一轮多事件按
 *     「prune→replace」相邻成对写入，满足宿主折叠的邻接消费约束；
 *   - fail-soft：任何异常只 warn 日志跳过本轮，绝不阻塞 step；
 *   - 不动消息壳（source.callId 等）⇒ tool-call/result 配对、相邻性、配对平衡
 *     全部保持，strict provider 不会 400。
 *
 * @module dsh-some-optimizations/imageshed
 */

/** 宿主 meter 的固定密度启发式（dsh-token-meter estimate.js 镜像常量）。 */
const CHARS_PER_TOKEN = 4
/** 每块的结构开销（JSON framing + type tag）。 */
const BLOCK_OVERHEAD = 4
/** 每条消息的 role 字段开销。 */
const ROLE_OVERHEAD = 4

/**
 * 是否为图片块。覆盖四种已知形态：
 *  - DSH 附件引用：{type:'image', attachment:{attachmentId:'sha256:…', mediaType, bytes, width, height, name}}
 *  - 内联 base64：{type:'image', mimeType:'image/png', data:'<b64>'}
 *  - openai wire 风：{type:'image_url', image_url:{url:'data:image/…;base64,…'}}
 *  - anthropic 风：{source:{type:'base64', media_type:'image/png'}}
 * @param {unknown} block - 待判定内容块。
 * @returns {boolean}
 */
export function isImageBlock(block) {
	if (block === null || typeof block !== 'object') return false
	const b = /** @type {Record<string, any>} */ (block)
	if (b.type === 'image' || b.type === 'image_url') return true
	if (typeof b.mimeType === 'string' && b.mimeType.startsWith('image/')) return true
	const att = b.attachment
	if (att !== null && typeof att === 'object' && typeof att.mediaType === 'string' && att.mediaType.startsWith('image/')) return true
	const src = b.source
	if (src !== null && typeof src === 'object' && typeof src.media_type === 'string' && src.media_type.startsWith('image/')) return true
	return false
}

/** 从字符串估计 base64 载荷的原始字节数。 */
function base64Bytes(text) {
	const comma = text.indexOf(',')
	const payload = text.startsWith('data:') && comma >= 0 ? text.slice(comma + 1) : text
	return Math.floor((payload.length * 3) / 4)
}

/** 图片块的内联载荷字节数（无内联数据时 undefined）。 */
function inlineBytesOf(block) {
	const b = /** @type {Record<string, any>} */ (block)
	for (const key of ['data', 'image_data', 'b64_json', 'base64']) {
		if (typeof b[key] === 'string') return base64Bytes(b[key])
	}
	for (const key of ['imageUrl', 'image_url']) {
		const url = b[key]?.url
		if (typeof url === 'string') return base64Bytes(url)
	}
	if (typeof b.url === 'string') return base64Bytes(b.url)
	return undefined
}

/**
 * 生成占位符文本：保留「这里曾有一张什么图」的最小线索
 * （名字 / 类型 / 尺寸 / 哈希前缀），绝不带回图片数据本身。
 * @param {object} block - 原图片块。
 * @returns {string}
 */
export function describeImageBlock(block) {
	const b = /** @type {Record<string, any>} */ (block)
	const att = b.attachment && typeof b.attachment === 'object' ? b.attachment : {}
	const parts = []
	if (typeof att.name === 'string' && att.name) parts.push(att.name)
	const mime = att.mediaType ?? b.mimeType ?? b.source?.media_type ?? (b.type === 'image_url' ? 'image' : undefined)
	if (typeof mime === 'string' && mime !== 'image') parts.push(mime)
	const bytes = typeof att.bytes === 'number' ? att.bytes : inlineBytesOf(b)
	if (typeof bytes === 'number' && Number.isFinite(bytes)) {
		parts.push(bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`)
	}
	if (typeof att.width === 'number' && typeof att.height === 'number') parts.push(`${att.width}x${att.height}`)
	else if (typeof b.width === 'number' && typeof b.height === 'number') parts.push(`${b.width}x${b.height}`)
	if (typeof att.attachmentId === 'string' && att.attachmentId.startsWith('sha256:')) {
		parts.push(att.attachmentId.slice(7, 15))
	}
	return `[image pruned by some-optimizations${parts.length > 0 ? ': ' + parts.join(' ') : ''}]`
}

/**
 * 深度遍历 content（块数组 / 字符串 / 任意嵌套），把其中一切图片块替换成占位符
 * 文本块；`keep` 里的对象引用原样保留（部分替换：同一事件里只 shed 超额的旧图，
 * 兄弟新图不动）。其余内容逐字段原样重建（字符串共享引用，不复制大文本）。
 * @param {unknown} content - 原始 content。
 * @param {WeakSet<object> | undefined} keep - 豁免替换的图片块引用集合。
 * @returns {{ content: unknown, removed: object[] }} 新 content 与被替换的原图块列表。
 */
export function shedImagesInContent(content, keep) {
	/** @type {object[]} */
	const removed = []
	const walk = (node) => {
		if (Array.isArray(node)) return node.map(walk)
		if (node !== null && typeof node === 'object') {
			if (isImageBlock(node)) {
				if (keep !== undefined && keep.has(node)) return node
				removed.push(node)
				return { type: 'text', text: describeImageBlock(node) }
			}
			/** @type {Record<string, unknown>} */
			const out = {}
			for (const key of Object.keys(node)) out[key] = walk(node[key])
			return out
		}
		return node
	}
	return { content: walk(content), removed }
}

// ── 宿主词汇表计价镜像（移植自 billion-context-dsh/src/host-tokens.ts，
//    逐行对齐 @deepseek-ai/dsh-token-meter estimate.js）────────────────

function blockTypeOf(block) {
	if (typeof block !== 'object' || block === null) return undefined
	const type = block.type
	return typeof type === 'string' ? type : undefined
}

/**
 * 宿主 estimateContent 的精确镜像：text/reasoning `ceil(len/4)+4`，
 * tool-call `ceil(name/4)+ceil(arguments/4)+4`，tool-result 递归其 content，
 * 其余块 `4+ceil(JSON.stringify(原块)/4)`；字符串 content 逐字符落默认分支。
 * @param {unknown} blocks - 块数组或裸字符串。
 * @returns {number}
 */
export function estimateHostContent(blocks) {
	if (typeof blocks === 'string') {
		let tokens = 0
		for (const char of blocks) tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(char).length / CHARS_PER_TOKEN)
		return tokens
	}
	let tokens = 0
	for (const block of blocks) {
		switch (blockTypeOf(block)) {
			case 'text':
			case 'reasoning': {
				tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
				break
			}
			case 'tool-call': {
				tokens += Math.ceil((block.name ?? '').length / CHARS_PER_TOKEN) + Math.ceil((block.arguments ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
				break
			}
			case 'tool-result': {
				tokens += estimateHostContent(block.content) + BLOCK_OVERHEAD
				break
			}
			default:
				tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
		}
	}
	return tokens
}

/** 宿主 estimateMessage 镜像（content + role 开销）。 */
export function estimateHostMessage(message) {
	return estimateHostContent(message.content) + ROLE_OVERHEAD
}

/**
 * 宿主 deriveEventMessage 的精确镜像（dsh-session/lib/index.js:278-287）：
 * user/message → data 本体；assistant/message 空 content → null；tool/result →
 * data.message；其余 → null。
 */
function deriveEventMessageMirror(event) {
	switch (event.type) {
		case 'user/message': return event.data
		case 'assistant/message': return event.data?.message?.content?.length > 0 ? event.data.message : null
		case 'tool/result': return event.data?.message ?? null
		default: return null
	}
}

/** 单事件宿主价（镜像兜底路径）。 */
export function hostPriceEvent(event) {
	const message = deriveEventMessageMirror(event)
	return message === null ? 0 : estimateHostMessage(message)
}

/**
 * 影子价：优先活体 meter 的逐节点价（构造即精确、随宿主估计器演进），
 * 任一失败回落到上面的精确镜像。绝不返回 CJK 计数（rule 12）。
 * @param {object} session - 宿主会话。
 * @param {number[]} seqs - 被遮蔽的 seq 集。
 * @param {object | undefined} ctx - cordis 上下文（取 tokenMeter 服务）。
 * @returns {number}
 */
export function shadowedTokensViaMeter(session, seqs, ctx) {
	try {
		const meter = ctx?.get?.('tokenMeter') ?? ctx?.tokenMeter
		if (meter && typeof meter.measure === 'function') {
			const bySeq = new Map(meter.measure(session).nodes.map((node) => [node.seq, node.tokens]))
			let total = 0
			let missing = false
			for (const seq of seqs) {
				const tokens = bySeq.get(seq)
				if (tokens === undefined) {
					missing = true
					break
				}
				total += tokens
			}
			if (!missing) return total
		}
	} catch {}
	let total = 0
	for (const seq of seqs) {
		const event = session.events[seq]
		if (event !== undefined) total += hostPriceEvent(event)
	}
	return total
}

// ── 主扫描 ────────────────────────────────────────────────────────────

/** 会触发滚动扫描的三种表面追加事件。 */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** 表面事件是否为携带可重写 content 的三种消息事件之一。 */
function messageRootOf(event) {
	if (event.type === 'user/message') return { root: event.data?.content, kind: 'data' }
	if (event.type === 'assistant/message' || event.type === 'tool/result') return { root: event.data?.message?.content, kind: 'message' }
	return { root: undefined, kind: null }
}

function isCheckpointEvent(event) {
	return event?.type === 'user/message' && event.data?.source?.plugin === 'compact'
}

/** 深度收集 content 树里的图片块引用（保持出现次序）。 */
function collectImageRefs(node, seq, out) {
	if (Array.isArray(node)) {
		for (const item of node) collectImageRefs(item, seq, out)
		return
	}
	if (node !== null && typeof node === 'object') {
		if (isImageBlock(node)) {
			out.push({ seq, ref: node })
			return
		}
		for (const key of Object.keys(node)) collectImageRefs(node[key], seq, out)
	}
}

/**
 * 一次 measure 批量解析所有目标的影子价：优先活体 tokenMeter 的逐节点价，
 * 任一目标缺失或 meter 不可用则整批回落本地镜像。每轮扫描至多 measure 一次
 * （它自身要遍历会话，按事件逐个调用会把 O(n) 放大成 O(n²)）。
 * @param {object} session - 宿主会话。
 * @param {number[]} targets - 待替换的 seq 列表。
 * @param {object | undefined} ctx - cordis 上下文。
 * @returns {number[]} 与 targets 对齐的 claim 数组。
 */
function resolveClaimsInBatch(session, targets, ctx) {
	let bySeq
	try {
		const meter = ctx?.get?.('tokenMeter') ?? ctx?.tokenMeter
		const nodes = meter && typeof meter.measure === 'function' ? meter.measure(session).nodes : undefined
		if (Array.isArray(nodes)) bySeq = new Map(nodes.map((node) => [node.seq, node.tokens]))
	} catch {}
	return targets.map((seq) => {
		if (bySeq !== undefined) {
			const tokens = bySeq.get(seq)
			if (tokens !== undefined) return tokens
		}
		const event = session.events[seq]
		return event === undefined ? 0 : hostPriceEvent(event)
	})
}

/**
 * 滚动保留最新 `keepLatest` 张图片：从表面最新端向旧端收集图片块，超出配额的
 * 按持久化协议替换成占位符。幂等；总量不超配额时不做任何事。同一事件内只去掉
 * 超额旧图、兄弟新图原样保留（部分替换），claim 仍按整节点宿主价计——宿主折叠
 * 公式是 delta = 新节点价 − claim，只有整节点价才能精确对账。
 * @param {object} session - 宿主会话（append-only 日志 + 折叠表面）。
 * @param {number} keepLatest - 全表面保留的最新图片块数量（≥0）。
 * @param {object | undefined} ctx - cordis 上下文。
 * @returns {{ shedEvents: number, images: number }}
 */
export function shedToLatestImages(session, keepLatest, ctx) {
	const nodes = session.surface.nodes
	/** @type {{ seq: number, ref: object }[]} 最新→最老。 */
	const all = []
	for (let i = nodes.length - 1; i >= 0; i -= 1) {
		const event = session.events[nodes[i]]
		if (event === undefined || isCheckpointEvent(event)) continue
		const { root } = messageRootOf(event)
		if (!Array.isArray(root)) continue
		// 节点内按数组序即时间序（末位最新），反转后并入全局「最新→最老」序列。
		const refs = []
		collectImageRefs(root, Number(nodes[i]), refs)
		for (let j = refs.length - 1; j >= 0; j -= 1) all.push(refs[j])
	}
	if (!(keepLatest >= 0) || all.length <= keepLatest) return { shedEvents: 0, images: 0 }

	const keep = new WeakSet()
	for (let i = 0; i < keepLatest; i += 1) keep.add(all[i].ref)
	const seen = new Set()
	const targets = []
	for (let i = keepLatest; i < all.length; i += 1) {
		if (!seen.has(all[i].seq)) {
			seen.add(all[i].seq)
			targets.push(all[i].seq)
		}
	}
	targets.sort((a, b) => a - b) // 按日志序写入：每对 prune→replace 保持相邻

	let shedEvents = 0
	let images = 0
	const claims = resolveClaimsInBatch(session, targets, ctx)
	for (let index = 0; index < targets.length; index += 1) {
		const seq = targets[index]
		const event = session.events[seq]
		const { root, kind } = messageRootOf(event)
		if (!Array.isArray(root)) continue
		const { content, removed } = shedImagesInContent(root, keep)
		if (removed.length === 0) continue

		// 1) 影子价目（= 整个原节点的宿主价）；2) 同类型替换（壳不动）。
		session.append('compaction/prune', {
			shadowedRange: { start: seq, end: seq },
			shadowedSeqs: [seq],
			shadowedTokenCount: claims[index],
		})
		const options = { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] }
		if (kind === 'data') {
			session.append('user/message', { ...event.data, content }, options)
		} else {
			session.append(event.type, { ...event.data, message: { ...event.data.message, content } }, options)
		}
		shedEvents += 1
		images += removed.length
	}
	return { shedEvents, images }
}

/**
 * 安装 image-shed 监听：表面上追加图片类消息事件、或任何引擎的 compaction/
 * summary 落地后（微任务延迟避开 append 重入窗口），执行一轮「保留最新 N 张」
 * 扫描。同一微任务排空内的多次触发合并为一次扫描（按会话去重）。返回注销函数。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} options
 * @param {() => boolean} options.enabled - 实时总开关（设置面热切生效）。
 * @param {() => number} options.keepLatest - 实时保留张数（≥0）。
 * @param {Console | undefined} options.logger - 日志出口。
 * @returns {() => void} 注销函数。
 */
export function installImageShed(ctx, { enabled, keepLatest, logger }) {
	/** @type {Set<object>} */
	const pending = new Set()
	/** @type {WeakMap<object, { seq: number, fingerprint: string }>} */
	const lastScan = new WeakMap()
	let disposed = false
	const run = (session) => {
		pending.delete(session)
		if (disposed || !enabled()) return
		try {
			const quota = Math.max(0, Math.floor(keepLatest()))
			const nodes = session.surface.nodes
			const tailSeq = nodes.length > 0 ? Number(nodes[nodes.length - 1]) : -1
			const fingerprint = `${enabled() ? 1 : 0}:${quota}`
			const previous = lastScan.get(session)
			if (previous !== undefined && previous.seq === tailSeq && previous.fingerprint === fingerprint) return
			const result = shedToLatestImages(session, quota, ctx)
			const after = session.surface.nodes
			lastScan.set(session, { seq: after.length > 0 ? Number(after[after.length - 1]) : -1, fingerprint })
			if (result.shedEvents > 0) {
				logger?.info?.(`some-optimizations image-shed: kept latest ${quota} image block(s), pruned ${result.images} older one(s) from ${result.shedEvents} message(s)`)
			}
		} catch (error) {
			logger?.warn?.(`some-optimizations image-shed skipped: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	const dispose = ctx.on('session/event', (session, event) => {
		if (event.type !== 'compaction/summary' && !MESSAGE_TYPES.has(event.type)) return
		if (pending.has(session)) return
		pending.add(session)
		// append 不可重入：此刻还在本次 append 的发布期内，微任务等它完全落地后再跑。
		queueMicrotask(() => run(session))
	})
	return () => {
		disposed = true
		dispose()
	}
}
