// dsh-memory-vault · 插件入口（Host 侧）
//
// 定位：把「跨会话」的历史对话沉淀成一份本地长期记忆库，每轮对话前按需检索一小段
// 注入提示词。它不（也不可能）扩大模型的上下文窗口——上下文窗口是模型侧的硬上限，
// 磁盘再大也换不来 token。它做的是把「窗口外的信息」变成「窗口内的一小段摘录」。
//
// 与既有插件的关系：
//   · billion-context / bili 代理 —— 做「会话内」压缩，关注当前窗口装不下时怎么办；
//   · dsh-recall-plugin        —— 做消息撤回；
//   · 本插件                    —— 做「跨会话」持久记忆，三者互补不冲突。
//
// 三条硬约束（都是实测踩出来的，别改）：
//   1. 不 import @deepseek-ai/schemastery：pnpm 只为已声明依赖建链接，解析不到，
//      会让整个插件加载失败。Config 用 standard-schema 接口自己实现。
//   2. 不写 static Config = z.object(...)。Cordis 只认 config['~standard'].validate。
//   3. @deepseek-ai/dsh-tools 动态 import 要包 try/catch：拿不到就降级（不注册工具），
//      采集/召回照常工作，绝不能因为工具装配失败让插件整体炸掉。

import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// store.js / panel.js **刻意不写成静态 import**：静态 import 在模块求值期就解析，
// 一旦它们（或它们内部的 node:sqlite）加载失败，本文件整个求值失败、apply 一行都不会跑，
// 诊断日志也就一个字都留不下 —— 那正是最难查的形态。改成 apply 内动态 import，
// 加载失败会变成一条可读的 diag 行 + 一次降级，而不是「插件凭空不存在」。
let MemoryStore
let makeSnippet
let registerPanel
// 由 store.js 动态导入后回填，避免入口静态依赖存储层（见 apply 里的降级理由）
let gigabytesToBytes
let SIZE_PRESETS = [1, 5, 10, 20, 50]
let isValidMode = () => false
let MEMORY_MODES = ['long', 'multi', 'once']

export const name = 'dsh-memory-vault'

/** 注入到 user 角色消息里的召回块标记。采集侧据此跳过，防止「自己召回的内容被自己记下来」的死循环。 */
const RECALL_MARK = '【长期记忆·自动召回】'
/** 会话索引块（新会话第一轮注入一次）。同样不能入库。 */
const INDEX_MARK = '【长期记忆·会话索引】'
/** DSH 自己注入的运行时上下文前缀，同样不能入库。 */
const RUNTIME_CONTEXT_MARK = 'Current runtime context. This snapshot supersedes earlier'

const MB = 1024 * 1024
const GB = 1024 * MB

function defaultDbPath() {
  if (process.platform === 'win32') return 'D:\\dsh-memory\\vault.db'
  return join(homedir(), '.dsh-memory', 'vault.db')
}

// apply 的顶层兜底日志：此时 config 可能都没解析出来（或 run 挂在半路），
// 没法用 run 内的 diag（它依赖已解析的 dbPath），所以按默认库路径独立写一份。
function fallbackDiag(message) {
  try {
    const base = defaultDbPath().replace(/[\\/][^\\/]+$/, '')
    const path = base + (process.platform === 'win32' ? '\\' : '/') + 'debug.log'
    if (existsSync(path) && statSync(path).size > 512 * 1024) writeFileSync(path, '')
    appendFileSync(path, `${new Date().toISOString()} pid=${process.pid} ${message}\n`)
  } catch {
    /* 连排障日志都写不进去时，只剩 logger 那条通道，不该再抛 */
  }
}

// ── Config ───────────────────────────────────────────────────────────────
// 用 standard-schema 接口（Cordis 在加载期调用 validate，非法配置会响亮失败），
// 每个键都带 why，方便用户在设置面板里理解它到底在控制什么。
const CONFIG_SCHEMA = Object.freeze({
  enabled: { kind: 'boolean', def: true, why: '总开关。关掉后不采集也不召回，但已有记忆保留。' },
  dbPath: { kind: 'string', def: defaultDbPath(), why: '记忆库文件路径（SQLite）。换路径不会迁移旧数据。' },
  maxGB: { kind: 'number', def: 5, min: 0.05, max: 200, why: '自定义容量（GB）。仅当 sizePreset = "custom" 时生效。超出后按「最旧优先」淘汰到 90%。' },
  sizePreset: {
    kind: 'enum',
    def: 'custom',
    values: ['custom', '1', '5', '10', '20', '50'],
    why: '容量常用档位：1/5/10/20/50（GB）。选 "custom" 才用 maxGB；选档位时忽略 maxGB。面板与 memory_resize 可随时改，改完落库、重启不丢。',
  },
  capture: { kind: 'boolean', def: true, why: '自动把对话沉淀进记忆库。' },
  captureAssistant: { kind: 'boolean', def: true, why: '是否连助手回复一起记。关掉只记你说的。' },
  skipSubagent: { kind: 'boolean', def: true, why: '跳过子代理会话（避免把它们的中间过程记成记忆）。' },
  captureMinChars: { kind: 'number', def: 8, min: 0, max: 2000, why: '短于这个字数的消息不记（「嗯」「好的」不值得占库）。' },
  recall: { kind: 'boolean', def: true, why: '每轮对话前自动检索并注入相关记忆。' },
  recallLimit: { kind: 'number', def: 5, min: 1, max: 20, why: '单轮最多注入几条记忆。' },
  recallMaxChars: { kind: 'number', def: 1500, min: 200, max: 12000, why: '单轮注入的记忆总字数上限（占提示词预算）。' },
  recallMinQueryChars: { kind: 'number', def: 4, min: 1, max: 200, why: '输入短于这个字数就不检索（避免「嗯」「好的」触发无意义查询）。' },
  recallSameSession: { kind: 'boolean', def: true, why: '是否也取当前会话里更早的记忆（最近 recallRecentWindow 条以内的不取，因为那部分还在上下文里）。关掉则只跨会话召回。' },
  recallRecentWindow: { kind: 'number', def: 30, min: 0, max: 500, why: '当前会话最近这么多条不参与召回（防止把刚说过的话重复塞回上下文）。' },
  sessionIndex: { kind: 'boolean', def: true, why: '新会话第一轮注入一次「过去会话要点」：每个会话压成两三行抽取式摘要。这是「压缩层」——决定能累积多少个会话而不撑爆窗口。' },
  sessionIndexLimit: { kind: 'number', def: 6, min: 1, max: 20, why: '会话索引最多列几个过去会话（每个约 150 字，只在新会话第一轮付一次）。' },
  panel: { kind: 'boolean', def: true, why: 'Web 侧边面板（用量条 / 检索 / 最近记忆）。它会在宿主 Web 载体上新增一个**只读** HTTP 面 /memory-vault/*，随监听地址暴露（本机默认回环）。' },
  defaultMode: {
    kind: 'enum',
    def: 'long',
    values: ['long', 'multi', 'once'],
    why: '默认记忆模式。long=长期（永久、跨会话）；multi=多次（只在本会话可见，12 小时后清掉）；once=单次（被召回一次就删除，不留痕）。memory_save 传 mode 可单条覆盖。',
  },
  captureMode: {
    kind: 'enum',
    def: 'long',
    values: ['long', 'multi', 'once'],
    why: '自动采集用哪种模式。想让「聊天自动进库」保持长期就用 long；想让自动采集只在本会话有效，就改成 multi（隐私更稳）。',
  },
})

function validateConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const value = {}
  const issues = []
  for (const [key, spec] of Object.entries(CONFIG_SCHEMA)) {
    const provided = input[key]
    if (provided === undefined || provided === null) {
      value[key] = spec.def
      continue
    }
    if (spec.kind === 'boolean') {
      if (typeof provided !== 'boolean') issues.push({ message: `应为布尔值，收到 ${typeof provided}`, path: [key] })
      else value[key] = provided
    } else if (spec.kind === 'number') {
      const num = typeof provided === 'number' ? provided : Number(provided)
      if (!Number.isFinite(num)) issues.push({ message: '应为数字', path: [key] })
      else if (spec.min !== undefined && num < spec.min) issues.push({ message: `不能小于 ${spec.min}`, path: [key] })
      else if (spec.max !== undefined && num > spec.max) issues.push({ message: `不能大于 ${spec.max}`, path: [key] })
      else value[key] = num
    } else if (spec.kind === 'string') {
      if (typeof provided !== 'string' || provided.trim() === '') issues.push({ message: '应为非空字符串', path: [key] })
      else value[key] = provided.trim()
    } else if (spec.kind === 'enum') {
      const text = String(provided)
      if (!spec.values.includes(text)) issues.push({ message: `只能是 ${spec.values.join(' / ')}`, path: [key] })
      else value[key] = text
    }
  }
  return issues.length > 0 ? { issues } : { value }
}

export const Config = Object.freeze({
  description: '5GB 磁盘长期记忆库：自动沉淀跨会话记忆、按需检索注入、Web 用量面板。',
  ...CONFIG_SCHEMA,
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-memory-vault',
    validate: validateConfig,
  }),
})

/** 兜底解析：Cordis 会先跑 ~standard.validate，但手工构造的场景（测试、直接调用）也要能用。 */
export function resolveConfig(raw) {
  const result = validateConfig(raw)
  if (result.issues) {
    throw new TypeError(`dsh-memory-vault 配置非法：${result.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
  }
  return result.value
}

/**
 * 配置 → 实际配额字节。档位优先：sizePreset 不是 "custom" 时忽略 maxGB。
 * 配置校验已经挡了一道非法值，这里是双保险（解析不到就回 5GB）。
 */
export function resolveMaxBytes(config, toBytes) {
  const convert = typeof toBytes === 'function' ? toBytes : (gb) => Math.round(Number(gb) * 1024 ** 3)
  const preset = String(config?.sizePreset ?? 'custom')
  const gb = preset === 'custom' ? Number(config?.maxGB ?? 5) : Number(preset)
  const bytes = convert(Number.isFinite(gb) ? gb : 5)
  const min = 50 * 1024 * 1024
  const max = 200 * 1024 ** 3
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return 5 * 1024 ** 3
  if (Number(bytes) < min || Number(bytes) > max) return 5 * 1024 ** 3
  return Number(bytes)
}

// ── 消息正文提取 ─────────────────────────────────────────────────────────
// 只取 text 块：thinking / tool_use / tool_result 对「找回原话」没帮助，还会把库撑爆。
function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
    } else if (block && typeof block === 'object') {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 该不该把这条 user 消息入库（排除我们自己注入的召回块与 DSH 的运行时上下文）。 */
function isCapturableUserText(text) {
  if (!text) return false
  if (text.startsWith(RECALL_MARK)) return false
  if (text.startsWith(INDEX_MARK)) return false
  if (text.startsWith(RUNTIME_CONTEXT_MARK)) return false
  // 运行时上下文可能被拼在长消息中间，兜底再查一次开头 200 字
  if (text.slice(0, 200).includes(RUNTIME_CONTEXT_MARK)) return false
  return true
}

function titleOf(text) {
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  return firstLine.slice(0, 60)
}

function formatDate(ts) {
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return '?'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 会话 id 的短名。宿主给的是 `session-<uuid>`，直接 slice(0,8) 只会得到全一样的 `session-`，
 * 所以先剥前缀，取不到再退回 8 位。
 */
function shortSession(id) {
  const raw = String(id ?? '')
  if (!raw) return '(未命名)'
  const stripped = raw.startsWith('session-') ? raw.slice(8) : raw
  return (stripped || raw).slice(0, 8)
}

/**
 * 把检索结果渲染成注入提示词的文本。
 * 带「可能不准 / 冲突以当前指令为准」的措辞：召回是概率匹配，不能让模型把它当权威事实。
 */
function renderRecall(results, maxChars, footer = '') {
  if (results.length === 0) return ''
  const lines = [
    `${RECALL_MARK}以下是从你过去其它会话里检索到的相关记忆（按相关度排序，共 ${results.length} 条）。`,
    '这些是自动匹配的结果，可能不完全对题；与当前指令冲突时，一律以当前指令为准。',
  ]
  let used = 0
  for (const [index, item] of results.entries()) {
    // 带 id：召回只给摘录，模型想读全文时可以用 memory_open 按 id 分段读。
    const head = `${index + 1}. [id=${item.id} · ${formatDate(item.ts)} · ${item.role === 'assistant' ? '助手' : '用户'}] `
    const budget = Math.max(60, maxChars - used - head.length)
    if (budget <= 60) break
    const body = item.snippet.length > budget ? item.snippet.slice(0, budget) + '…' : item.snippet
    lines.push(head + body)
    used += head.length + body.length
    if (used >= maxChars) break
  }
  if (footer) lines.push(footer)
  return lines.join('\n')
}

// ── 插件主体 ─────────────────────────────────────────────────────────────
export async function apply(ctx, rawConfig) {
  try {
    await run(ctx, rawConfig)
  } catch (error) {
    // 最后一道闸：apply 绝不向外抛。cordis 里 apply 抛错会把整个 fiber 判失败，
    // 已经装好的部分（面板 / 采集 / 工具）会跟着一起被撤掉，而报错往往只有一行。
    const text = `apply 顶层未捕获异常：${error?.stack ?? error}`
    try {
      fallbackDiag(text)
    } catch {
      /* 连日志都写不了就算了 */
    }
    try {
      ctx?.logger?.warn?.(`dsh-memory-vault ${text}`)
    } catch {
      /* ignore */
    }
  }
}

async function run(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('memory-vault') : undefined
      if (logger && typeof logger[level] === 'function') logger[level](message)
      else if (level === 'warn' || level === 'error') console.warn(`[dsh-memory-vault] ${message}`)
    } catch {
      /* 日志通道不可用不该影响主流程 */
    }
  }

  // 排障用文件日志：宿主里的日志通道看不见（logger 可能没接线、console 也可能被吞），
  // 所以在库文件旁边再写一份 debug.log，出问题时直接看这个文件。
  const diagPath = config.dbPath.replace(/[\\/][^\\/]+$/, '') + (process.platform === 'win32' ? '\\' : '/') + 'debug.log'
  const diag = (message) => {
    try {
      if (existsSync(diagPath) && statSync(diagPath).size > 512 * 1024) writeFileSync(diagPath, '')
      appendFileSync(diagPath, `${new Date().toISOString()} pid=${process.pid} ${message}\n`)
    } catch {
      /* 排障日志写不进去不该影响主流程 */
    }
  }

  diag(`apply 进入 · enabled=${config.enabled} dbPath=${config.dbPath} capture=${config.capture} recall=${config.recall}`)

  if (!config.enabled) {
    log('info', '已禁用（enabled=false），不采集不召回。')
    return
  }

  // ── 1. 打开记忆库 ──
  try {
    const mod = await import('./store.js')
    MemoryStore = mod.MemoryStore
    makeSnippet = mod.makeSnippet
    gigabytesToBytes = mod.gigabytesToBytes
    SIZE_PRESETS = mod.SIZE_PRESETS
    if (typeof mod.isValidMode === 'function') isValidMode = mod.isValidMode
    if (Array.isArray(mod.MEMORY_MODES)) MEMORY_MODES = mod.MEMORY_MODES
    diag(`store.js 已加载 MemoryStore=${typeof MemoryStore}`)
  } catch (error) {
    diag(`store.js 加载失败：${error?.stack ?? error}`)
    log('error', `记忆库模块加载失败，本插件本次不工作：${error?.message ?? error}`)
    return
  }

  let store
  try {
    store = new MemoryStore({
      dbPath: config.dbPath,
      maxBytes: resolveMaxBytes(config, gigabytesToBytes),
    })
  } catch (error) {
    // 存储打不开（盘符不存在 / D 盘满 / sqlite 不可用）时**整体降级**，
    // 绝不抛出去——否则会把宿主启动链带崩。
    log('error', `记忆库打开失败，本插件本次不工作：${error?.message ?? error}`)
    diag(`记忆库打开失败：${error?.message ?? error}\n${error?.stack ?? ''}`)
    return
  }

  const initial = store.stats()
  log('info', `记忆库就绪：${initial.rows} 条 / ${initial.usedMB}MB（上限 ${initial.maxMB}MB）@ ${initial.dbPath}`)
  diag(`store 就绪 rows=${initial.rows} bytes=${initial.bytes} db=${initial.dbPath} maxMB=${initial.maxMB}`)

  // 过期的「本会话多次」记忆（进程重启=上个会话已结束）在这里清掉；
  // 单次记忆若一直没被召回，超过兜底期也一并清掉。
  try {
    const purged = store.purgeTransient()
    if (purged.multi || purged.once) diag(`清理过期记忆 multi=${purged.multi} once=${purged.once}`)
  } catch (error) {
    diag(`purgeTransient 失败：${error?.message ?? error}`)
  }

  // ── 1.4 会话级记忆模式（输入框右侧那个选择器写这里）──
  // 用户在 composer 里选了「长期 / 本会话 / 单次」之后，本会话的**自动采集**
  // 与 memory_save 的默认模式都跟着走；没选过就退回配置里的 captureMode。
  // 只存在内存里：模式是「这次会话怎么记」的临时决定，重启即回默认值。
  const SESSION_MODES = new Map()
  const SESSION_MODE_LIMIT = 500
  const modeForSession = (sessionId) => SESSION_MODES.get(String(sessionId ?? '')) ?? config.captureMode
  const setModeForSession = (sessionId, mode) => {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new Error('session 不能为空')
    if (!isValidMode(mode)) throw new Error(`mode 只能是 long / multi / once，收到的是「${mode}」`)
    SESSION_MODES.set(id, mode)
    while (SESSION_MODES.size > SESSION_MODE_LIMIT) SESSION_MODES.delete(SESSION_MODES.keys().next().value)
    return mode
  }

  // ── 1.5 浏览器面板的宿主半边（只读 HTTP 面）──
  // 提到最前：它只依赖 webServer 服务，与后面的采集/召回/工具注册互不牵连，
  // 后面任何一段出错都不该让面板消失。
  if (config.panel) {
    try {
      const mod = await import('./panel.js')
      registerPanel = mod.registerPanel
      diag(`panel.js 已加载 registerPanel=${typeof registerPanel}`)
      registerPanel(ctx, store, log, {
        modes: MEMORY_MODES,
        defaultMode: config.captureMode,
        getSessionMode: modeForSession,
        setSessionMode: setModeForSession,
      })
      diag('面板路由注册已尝试')
    } catch (error) {
      log('warn', `· 面板路由注册异常（不影响其它功能）：${error?.message ?? error}`)
      diag(`面板路由注册异常：${error?.stack ?? error}`)
    }
  }

  // ── 2. 采集队列 ──
  // 每条消息都同步写 SQLite 会拖慢对话（一次 append 一次 fsync），
  // 所以先进内存队列，1 秒批量落盘；dispose 时强制 flush，避免丢尾部。
  const pending = []
  const lastUserBySession = new Map()
  let flushTimer = null
  let disposed = false

  const flush = () => {
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    let created = 0
    for (const item of batch) {
      try {
        const result = store.save(item)
        if (result.created) created++
      } catch (error) {
        log('warn', `写入失败（丢弃该条）：${error?.message ?? error}`)
      }
    }
    if (created > 0) {
      try {
        const removed = store.enforceQuota()
        if (removed > 0) log('info', `超出配额，淘汰了 ${removed} 条最旧记忆。`)
      } catch (error) {
        log('warn', `配额检查失败：${error?.message ?? error}`)
      }
    }
  }

  const scheduleFlush = () => {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, 1000)
    // 别让这个定时器把进程留活（宿主退出时不该被插件吊住）
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  // ── 3. 订阅会话事件（采集 + 记录每会话最后一句用户输入，供召回当查询词）──
  let diagEvents = 0
  const onSessionEvent = (session, event) => {
    if (diagEvents < 60) {
      diagEvents++
      diag(`收到事件 #${diagEvents} type=${event?.type} session=${session?.id} origin=${session?.header?.origin} keys=${event && typeof event === 'object' ? Object.keys(event).join(',') : typeof event}`)
    }
    if (disposed || !event || typeof event !== 'object') return
    const type = event.type
    if (type !== 'user/message' && type !== 'assistant/message') return

    // 子代理会话的中间过程不是「用户的记忆」，默认丢弃
    if (config.skipSubagent) {
      const header = session?.header
      if (header?.origin === 'subagent' || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) return
    }

    const data = event.data
    if (!data) return
    const message = type === 'assistant/message' ? data.message ?? data : data
    if (!message) return

    // user/message 只收真人输入：source.kind 不是 'user' 的都是宿主注入
    // （运行时上下文快照、压缩摘要、工具回填等）。字段缺失时按真人输入处理。
    if (type === 'user/message') {
      const sourceKind = message.source?.kind ?? data.source?.kind
      if (sourceKind !== undefined && sourceKind !== 'user') return
    }
    if (type === 'assistant/message' && !config.captureAssistant) return

    const text = textFromContent(message.content)
    if (!text) return

    if (type === 'user/message') {
      if (!isCapturableUserText(text)) return
      const sessionId = String(session?.id ?? '')
      if (sessionId) lastUserBySession.set(sessionId, text)
      if (!config.capture) return
      if (text.length < config.captureMinChars) return
      pending.push({
        ts: Number(event.time) || Date.now(),
        session: sessionId,
        role: 'user',
        title: titleOf(text),
        body: text,
        mode: modeForSession(sessionId),
      })
      scheduleFlush()
      return
    }

    if (!config.capture) return
    if (text.length < config.captureMinChars) return
    const replySession = String(session?.id ?? '')
    pending.push({
      ts: Number(event.time) || Date.now(),
      session: replySession,
      role: 'assistant',
      title: titleOf(text),
      body: text,
      mode: modeForSession(replySession),
    })
    scheduleFlush()
  }

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', onSessionEvent)
      diag('已订阅 session/event（根 ctx）')
    } else {
      diag(`ctx.on 不是函数：${typeof ctx.on}`)
    }
  } catch (error) {
    diag(`订阅 session/event 抛错：${error?.stack ?? error}`)
    log('warn', `订阅 session/event 失败，采集不可用：${error?.message ?? error}`)
  }

  // ── 4. 召回：以 systemPrompt.context 的形式注入（每个 step 重新 assemble）──
  // 用 context 而不是 section：context 是「随对话轮次变化的历史快照」，
  // 落在消息流里，不占系统提示词前缀，改它不会把 prompt cache 前缀打断。
  const injectedBySession = new Map()
  const introducedBySession = new Set()
  const RECALL_ORDER = 130 // 排在 SANDBOX_POLICY(110)/APPROVAL_POLICY(115)/SUBAGENT_DELEGATION(120) 之后

  /**
   * 「压缩层」：把过去每个会话压成两三行要点。
   * 只在新会话第一轮付一次成本，之后就靠检索按需取 ——
   * 原文可以无限长（5GB），进入窗口的永远只有这几行。
   */
  const renderIndex = (sessionId) => {
    if (!config.sessionIndex) return ''
    const list = store
      .sessionDigests({ limit: config.sessionIndexLimit, excludeSession: sessionId || undefined })
      .filter((item) => item.digest)
    if (list.length === 0) return ''
    const rows = Number(store.stats().rows ?? 0)
    const lines = [
      `${INDEX_MARK}库里已有 ${rows} 条记忆、${list.length} 个过去会话。每行是一个会话的要点（原文用 memory_open 分段读，换词搜用 memory_search）：`,
    ]
    for (const item of list) {
      const name = shortSession(item.session)
      lines.push(`- ${name} · ${item.count} 条 · ${formatDate(item.newest)} · ${item.digest}`)
    }
    return lines.join('\n')
  }

  const recallText = (context) => {
    if (!config.recall || disposed) return ''
    try {
      const agent = context?.agent
      const session = agent?.session
      const sessionId = String(session?.id ?? '')
      if (config.skipSubagent) {
        const header = session?.header
        if (header?.origin === 'subagent' || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) return ''
      }
      // 会话索引：每个会话只注入一次（第一轮），哪怕这一轮的输入太短、检索被跳过
      let intro = ''
      if (!introducedBySession.has(sessionId)) {
        intro = renderIndex(sessionId)
        introducedBySession.add(sessionId)
        if (introducedBySession.size > 200) {
          const oldestKey = introducedBySession.values().next().value
          if (oldestKey !== undefined) introducedBySession.delete(oldestKey)
        }
        if (intro) diag(`会话索引已注入 session=${sessionId} 行数=${intro.split('\n').length}`)
      }
      const query = lastUserBySession.get(sessionId) ?? ''
      if (query.trim().length < config.recallMinQueryChars) {
        diag(`召回跳过 session=${sessionId}：输入太短（${query.trim().length} < ${config.recallMinQueryChars}）`)
        return intro
      }
      const injected = injectedBySession.get(sessionId) ?? new Set()
      // 排除集：已注入过的 + （可选）当前会话最近 N 条。
      // 当前会话最近的内容本来就还在上下文里，取回来只是重复；更早的（尤其被压缩掉的）才值得取。
      const excludeIds = new Set(injected)
      if (config.recallSameSession) {
        for (const id of store.recentIdsBySession(sessionId, config.recallRecentWindow)) excludeIds.add(id)
      }
      const results = store.search(query, {
        limit: config.recallLimit,
        excludeSession: config.recallSameSession ? undefined : sessionId || undefined,
        excludeIds,
        scopeSession: sessionId || undefined,
      })
      diag(
        `召回 session=${sessionId} queryLen=${query.length} 命中=${results.length} 已注入=${injected.size}`,
      )
      if (results.length === 0) return intro
      // 尾注只占一行：让模型知道库比这一屏大得多、以及怎么继续取（这是「窗口不变但可达范围变大」的关键一环）
      const rows = Number(store.stats().rows ?? 0)
      const footer = `（库内共 ${rows} 条。要看全文用 memory_open id=上面对应的 id 分段读；换关键词重搜用 memory_search。）`
      const text = renderRecall(results, config.recallMaxChars, footer)
      if (!text) return intro
      // 记录已注入过的 id：同一会话不重复注入同一条，也顺手压住快照抖动
      for (const item of results) injected.add(item.id)
      injectedBySession.set(sessionId, injected)
      if (injectedBySession.size > 200) {
        const oldestKey = injectedBySession.keys().next().value
        if (oldestKey !== undefined) injectedBySession.delete(oldestKey)
      }
      store.markUsed(results.map((item) => item.id))
      // 「单次」模式：已经进了这一轮上下文，就把它从库里抹掉（先注入、后删除）。
      const onceIds = results.filter((item) => item.mode === 'once').map((item) => item.id)
      if (onceIds.length > 0) {
        const removed = store.consumeOnce(onceIds)
        diag(`单次记忆已消费并删除 ids=${onceIds.join(',')} removed=${removed}`)
      }
      return intro ? `${intro}\n\n${text}` : text
    } catch (error) {
      log('warn', `召回失败（本轮不注入）：${error?.message ?? error}`)
      return ''
    }
  }

  try {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      systemPrompt.context({ name: 'memory:recall', order: RECALL_ORDER, text: recallText })
      log('info', '自动召回已挂载（order=130）。')
    } else {
      log('warn', 'systemPrompt 服务不可用，自动召回未启用（记忆仍可用工具检索）。')
    }
  } catch (error) {
    log('warn', `挂载自动召回失败：${error?.message ?? error}`)
  }

  // ── 5. 工具 ──
  // 三个工具与「自动召回」刻意分开：召回是每轮自动的（省事但可能漏），
  // 工具是模型主动的（多一次调用但能问得准）。两条路都要能走通。
  let defineTool
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    defineTool = module.defineTool
    diag(`defineTool 取得：${typeof defineTool}`)
  } catch (error) {
    diag(`import dsh-tools 失败：${error?.stack ?? error}`)
    log('warn', `无法取得 defineTool，原生工具未启用：${error?.message ?? error}`)
  }

  let tools
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  } catch {
    tools = undefined
  }
  diag(`tools 服务：${tools === undefined ? 'undefined' : typeof tools} register=${typeof tools?.register}`)

  if (typeof defineTool === 'function' && tools && typeof tools.register === 'function') {
    // defineTool 的 DSL 校验在**调用它时**就会抛（不是注册时），所以把 create 包进
    // 同一个 try 里：某个工具定义写错，只丢这一个，不会连坐后面几个。
    const register = (toolName, create) => {
      try {
        const definition = create()
        tools.register(definition)
        diag(`工具已注册：${toolName}`)
      } catch (error) {
        diag(`工具注册失败 ${toolName}：${error?.stack ?? error}`)
        log('warn', `注册工具 ${toolName} 失败：${error?.message ?? error}`)
      }
    }

    register('memory_search', () =>
      defineTool({
        name: 'memory_search',
        description:
          '在本地长期记忆库（跨会话的历史对话，5GB 量级）里检索相关内容。用于「我们上次说过的 X」「之前定的方案是什么」这类需要找回历史原话的场合。返回按相关度排序的摘录。',
        parameters: {
          query: { type: 'string', required: true, description: '检索词或自然语言问句，中文可用整句。' },
          limit: { type: 'number', description: '返回条数，默认 5，上限 20。' },
          offset: { type: 'number', description: '跳过前 N 条，用于翻页看更多命中（默认 0）。' },
          session: { type: 'string', description: '只在这个会话 id 内检索；省略则检索所有会话。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 5)))
          const offset = Math.max(0, Math.min(200, Math.floor(Number(args.offset) || 0)))
          const results = store.search(String(args.query ?? ''), {
            limit,
            offset,
            ...(args.session ? { scopeSession: String(args.session) } : {}),
          })
          const filtered = args.session
            ? results.filter((item) => item.session === String(args.session))
            : results
          if (filtered.length === 0) {
            const stats = store.stats()
            const tail = offset > 0 ? `（已跳过前 ${offset} 条，说明翻到底了）` : ''
            return `没有检索到相关记忆${tail}（库里现有 ${stats.rows} 条 / ${stats.usedMB}MB）。换个说法或只用关键词再试一次；也可以 memory_catalog 先看库的整体结构。`
          }
          const lines = [`找到 ${filtered.length} 条相关记忆（共 ${store.stats().rows} 条）：`]
          for (const [index, item] of filtered.entries()) {
            lines.push(
              '',
              `${offset + index + 1}. [id=${item.id} · ${formatDate(item.ts)} · ${item.role === 'assistant' ? '助手' : '用户'}${item.session ? ` · 会话 ${shortSession(item.session)}` : ''}]`,
              item.snippet,
            )
          }
          if (filtered.length === limit) {
            lines.push('', `（要看更早的命中，加 offset=${offset + limit} 再搜一次；要看某条全文用 memory_open id=<上面的 id>。）`)
          } else {
            lines.push('', '（要看某条全文用 memory_open id=<上面的 id>。）')
          }
          return lines.join('\n')
        },
      }),
    )

    register('memory_open', () =>
      defineTool({
        name: 'memory_open',
        description:
          '按 id 分段读取一条记忆的完整正文。记忆库可以有 5GB、上下文只有十几万字，所以正文是按需分页读的：先 memory_search 拿到 id，再用本工具一次读一段（返回里带 next，接着读就传 offset=next）。',
        parameters: {
          id: { type: 'number', required: true, description: '记忆 id（memory_search / memory_recent 结果里的 id=…）。' },
          offset: { type: 'number', description: '从第几个字符开始读，默认 0；续读时传上一次返回的 next。' },
          chars: { type: 'number', description: '这一页读多少字符，默认 2400，范围 120~12000。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          const page = store.open(Number(args.id), {
            offset: Number(args.offset) || 0,
            chars: Number(args.chars) || 2400,
          })
          if (!page) return `没有 id=${args.id} 这条记忆（可能已被淘汰或删除）。用 memory_search 重新找，或 memory_stats 看库里还剩多少。`
          const range = `第 ${page.offset + 1}–${page.end} 字 / 共 ${page.total} 字`
          const nextLine = page.next === null ? '（已到末尾）' : `（续读：offset=${page.next}）`
          return [
            `[id=${page.id} · ${formatDate(page.ts)} · ${page.role === 'assistant' ? '助手' : '用户'}${page.session ? ` · 会话 ${shortSession(page.session)}` : ''}] ${page.title}`,
            `— ${range} ${nextLine}`,
            '',
            page.body,
          ].join('\n')
        },
      }),
    )

    register('memory_catalog', () =>
      defineTool({
        name: 'memory_catalog',
        description:
          '看记忆库的整体目录：总条数、按天分布、最近的会话、时间跨度。适合在不记得关键词时先摸清结构，再决定用 memory_search 搜什么。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute() {
          const stats = store.stats()
          if (!stats.rows) return '记忆库还是空的：还没有采集到任何对话。'
          const cat = store.catalog({ days: 14, sessions: 10 })
          const lines = [
            `记忆库：${stats.rows} 条 / ${stats.usedMB}MB（上限 ${stats.maxMB}MB）· ${formatDate(stats.oldest)} → ${formatDate(stats.newest)}`,
            '',
            '按天：',
            ...cat.days.map((day) => `  ${day.day} · ${day.count} 条 · ${Math.max(1, Math.round(day.bytes / 1024))}KB`),
            '',
            '最近的会话：',
            ...cat.sessions.map((s) => `  ${shortSession(s.session)} · ${s.count} 条 · 最近 ${formatDate(s.newest)}`),
            '',
            '（挑一个方向用 memory_search 搜；拿到 id 后用 memory_open 分段读全文。）',
          ]
          return lines.join('\n')
        },
      }),
    )

    register('memory_save', () =>
      defineTool({
        name: 'memory_save',
        description:
          '把一条值得记住的信息显式写入本地记忆库。自动采集已覆盖普通对话，这个工具用于手动强调「以后要记得」的内容：约定、偏好、关键决策、常用路径。mode 决定它能活多久：long=长期（默认，永久、跨会话）；multi=多次（只在本会话里可召回，12 小时后自动清掉）；once=单次（被召回一次就删除，库里不留痕）。',
        parameters: {
          text: { type: 'string', required: true, description: '要记住的内容本身，写成独立可读的完整句子。' },
          title: { type: 'string', description: '短标题，便于面板浏览；省略则取正文首行。' },
          mode: {
            type: 'string',
            description: '保留模式：long（长期）/ multi（本会话多次）/ once（召回一次即删）。省略用配置里的 defaultMode。',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const text = String(args.text ?? '').trim()
          if (!text) return '没有内容可存：text 为空。'
          const wanted = String(args.mode ?? '').trim()
          if (wanted && !isValidMode(wanted)) return `mode 只能是 long / multi / once，收到的是「${wanted}」。`
          const sessionId = String(exec?.agent?.session?.id ?? '').trim()
          // 没显式给 mode 时，跟随输入框右侧选择器给本会话选的那个模式
          const mode = wanted || (sessionId ? modeForSession(sessionId) : config.defaultMode)
          const result = store.save({
            ts: Date.now(),
            session: sessionId || 'manual',
            role: 'user',
            title: String(args.title ?? '').trim() || titleOf(text),
            body: text,
            mode,
          })
          const removed = store.enforceQuota()
          const stats = store.stats()
          const tail = removed > 0 ? `；超出配额，淘汰了 ${removed} 条最旧记忆` : ''
          const label = mode === 'long' ? '长期' : mode === 'multi' ? '本会话（12 小时后清）' : '单次（召回一次即删）'
          if (!result.created) return `这条内容库里已有（id=${result.id}），只更新了命中计数${tail}。当前 ${stats.rows} 条 / ${stats.usedMB}MB。`
          return `已记住（id=${result.id}，${result.bytes} 字节，模式：${label}）${tail}。当前 ${stats.rows} 条 / ${stats.usedMB}MB。`
        },
      }),
    )

    register('memory_stats', () =>
      defineTool({
        name: 'memory_stats',
        description: '查看本地长期记忆库的用量：条数、占用体积、配额上限、按角色分布、时间跨度。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute() {
          const stats = store.stats()
          const roles = Object.entries(stats.byRole).map(([role, count]) => `${role === 'assistant' ? '助手' : role === 'user' ? '用户' : role}=${count}`)
          const modes = Object.entries(stats.byMode ?? {}).map(([mode, count]) => `${mode === 'long' ? '长期' : mode === 'multi' ? '本会话' : mode === 'once' ? '单次' : mode}=${count}`)
          return [
            `记忆库：${stats.dbPath}`,
            `条数 ${stats.rows} · 占用 ${stats.usedMB}MB / 上限 ${stats.maxMB}MB（${stats.usedPercent}%）`,
            `容量 ${stats.maxGB}GB（${stats.quotaSource === 'override' ? '手动设定' : '配置文件'}）· 常用档位 ${SIZE_PRESETS.join('/')}GB，或自定义 0.05~200GB`,
            roles.length > 0 ? `分布 ${roles.join('，')}` : '分布 空',
            `模式 ${modes.length > 0 ? modes.join('，') : '空'}（长期=永久 / 本会话=12 小时后清 / 单次=召回一次即删）`,
            stats.oldest ? `时间跨度 ${formatDate(stats.oldest)} → ${formatDate(stats.newest)}` : '时间跨度 空',
          ].join('\n')
        },
      }),
    )

    register('memory_resize', () =>
      defineTool({
        name: 'memory_resize',
        description:
          '调整长期记忆库的容量上限。给 gigabytes 用常用档位（1/5/10/20/50）或任意自定义值（0.05~200）。' +
          '改完立即生效并落库，重启不会被配置覆盖。缩小容量会立刻淘汰超出的最旧记忆。',
        parameters: {
          gigabytes: { type: 'number', required: true, description: '目标容量（GB），例如 5 / 10 / 20，或 2.5 这样的自定义值。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          const gb = Number(args.gigabytes)
          if (!Number.isFinite(gb) || gb <= 0) return `容量非法：${args.gigabytes}（要给一个正数 GB）`
          try {
            const after = store.setQuotaGB(gb)
            const hint = SIZE_PRESETS.includes(gb) ? '（常用档位）' : '（自定义）'
            const dropped = after.removed > 0 ? `，为腾出空间淘汰了 ${after.removed} 条最旧记忆` : ''
            return `容量已设为 ${after.maxGB}GB${hint}${dropped}。当前 ${after.rows} 条 / ${after.usedMB}MB（${after.usedPercent}%）。`
          } catch (error) {
            return `容量设置失败：${error?.message ?? error}`
          }
        },
      }),
    )

    register('memory_forget', () =>
      defineTool({
        name: 'memory_forget',
        description: '按 id 删除一条长期记忆（不可恢复）。id 可从 memory_search 的结果里取。',
        parameters: {
          id: { type: 'number', required: true, description: '要删除的记忆 id。' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          const id = Math.floor(Number(args.id))
          if (!Number.isFinite(id) || id <= 0) return `id 非法：${args.id}`
          const ok = store.deleteById(id)
          const stats = store.stats()
          return ok
            ? `已删除 id=${id}。当前 ${stats.rows} 条 / ${stats.usedMB}MB。`
            : `没有 id=${id} 这条记忆。当前 ${stats.rows} 条 / ${stats.usedMB}MB。`
        },
      }),
    )

    log('info', '已注册工具：memory_search / memory_save / memory_stats / memory_resize / memory_forget。')
  } else if (!defineTool) {
    log('warn', '原生工具未注册（只有自动采集与自动召回在工作）。')
  }

  // ── 6. 收尾 ──
  const shutdown = () => {
    if (disposed) return
    disposed = true
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    try {
      flush()
    } catch {
      /* ignore */
    }
    try {
      store.close()
    } catch {
      /* ignore */
    }
    log('info', '记忆库已关闭。')
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => shutdown)
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', shutdown)
    }
  } catch {
    /* 拿不到生命周期钩子就只能靠进程退出 */
  }

  // 供同进程内的其它插件/测试探查（非契约，不保证存在）
  try {
    if (typeof ctx.provide === 'function') ctx.provide('memoryVault', { store, stats: () => store.stats(), search: (q, o) => store.search(q, o) })
  } catch {
    /* 可选能力，失败无妨 */
  }

  // 让 makeSnippet 的引用不被摇掉（面板侧复用同一实现）
  void makeSnippet
  diag('apply 结束（全部装配完成）')
}