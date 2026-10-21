// dsh-memory-vault · 存储层
//
// 只用 node:sqlite（Node 22.19+ / 24 内置，零原生依赖，无需 npm install）。
// 中文检索靠 FTS5 的 trigram 分词器：它对 CJK 是按 3 字符切片建索引的，
// 所以「记忆系统」这种中文短语能直接命中，不需要外部分词器。
//
// 设计取舍（为什么不是向量库）：
//   1. 向量模型要下载几百 MB 权重 + 常驻内存，而这里要的是「5GB 能用满」的
//      预算，权重不算在内更实在；
//   2. trigram 子串检索对「我记得之前说过 XXX」这类找原话的用法命中率已经很高；
//   3. 全同步 API，可以塞进同步的提示词组装路径（见 lib/index.js 的召回段）。

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mem (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  session  TEXT    NOT NULL,
  role     TEXT    NOT NULL,
  title    TEXT    NOT NULL DEFAULT '',
  body     TEXT    NOT NULL,
  hash     TEXT    NOT NULL,
  bytes    INTEGER NOT NULL,
  chars    INTEGER NOT NULL,
  hits     INTEGER NOT NULL DEFAULT 0,
  last_hit INTEGER NOT NULL DEFAULT 0,
  mode     TEXT    NOT NULL DEFAULT 'long'
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_hash ON mem(hash);
CREATE INDEX IF NOT EXISTS mem_ts ON mem(ts);
CREATE INDEX IF NOT EXISTS mem_session ON mem(session, ts);
-- mem_mode 不能放在这里：老库的 mem 表还没有 mode 列时，这条 CREATE INDEX 会直接抛
-- 「no such column: mode」，把整个 SCHEMA 执行打断（连带后面的建表/迁移全不跑）。
-- 它必须等下面的 ALTER TABLE 之后单独建。
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  body,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS mem_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 联想：两条记忆共享两个以上关键词时连一条边（weight = 共享词数）。
-- 检索命中 A 之后取 A 的最强邻居，模拟「想起这个就顺带想起那个」。
CREATE TABLE IF NOT EXISTS mem_assoc (
  a      INTEGER NOT NULL,
  b      INTEGER NOT NULL,
  weight REAL    NOT NULL DEFAULT 1,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS mem_assoc_a ON mem_assoc(a, weight DESC);
-- 事实卡：跨会话反复出现的内容（巩固层）。key 是关键词签名，重复只更新命中数。
CREATE TABLE IF NOT EXISTS mem_fact (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  key    TEXT    NOT NULL UNIQUE,
  body   TEXT    NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  source INTEGER NOT NULL DEFAULT 0,
  ts     INTEGER NOT NULL
);
`

/** 配额允许区间：50MB ~ 200GB。上限不是技术限制，是避免一次误配把整块盘写满。 */
export const MIN_BYTES = 50 * 1024 * 1024
export const MAX_BYTES = 200 * 1024 ** 3
/** 常用档位（GB）。自定义容量走同一个漂移校验。 */
export const SIZE_PRESETS = [1, 5, 10, 20, 50]

/**
 * 记忆的三种保留模式（用户可选）：
 * - `long`  长期：永久入库，跨会话召回，默认值。
 * - `multi` 多次：本会话内可反复召回；别的会话看不到，过期（默认 12 小时）后自动清掉。
 * - `once`  单次：被召回一次之后立刻删除，库里不留痕；适合「只提一次就别记着」的敏感内容。
 */
export const MEMORY_MODES = ['long', 'multi', 'once']

export function isValidMode(mode) {
  return MEMORY_MODES.includes(mode)
}

/** 多会话模式（multi）的存活时间；once 模式只是「召回一次即删」，补一个兜底清理期。 */
export const MULTI_TTL_MS = 12 * 60 * 60 * 1000
export const ONCE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 摘要时过滤掉的虚词/口头词：它们到处都在，撑不起「这句说了什么」。 */
const DIGEST_STOP = new Set([
  '这个', '那个', '就是', '可以', '我们', '你们', '他们', '什么', '怎么', '因为', '所以', '但是', '如果',
  '现在', '已经', '还是', '需要', '这样', '那样', '一下', '一样', '东西', '问题', '时候', '地方', '然后',
  '一个', '没有', '不是', '可能', '应该', '知道', '看到', '进行', '以及', '并且', '而且', '或者', '不过',
])

/** 把「GB」换算成字节，并夹到合法区间；非法值返回 null 让调用方自己报错。 */
export function gigabytesToBytes(gb) {
  const n = Number(gb)
  if (!Number.isFinite(n)) return null
  const bytes = Math.round(n * 1024 ** 3)
  if (bytes < MIN_BYTES || bytes > MAX_BYTES) return null
  return bytes
}

/** 把一段文本压成入库形态：去行尾空白、折叠三连空行、砍掉首尾空白。 */
export function normalizeBody(text, maxChars) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n')
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (maxChars > 0 && s.length > maxChars) s = s.slice(0, maxChars) + '\n…（已截断）'
  return s
}

/** 1 个 CJK 字符在 UTF-8 里是 3 字节，这里按实际字节算，配额才对得上磁盘。 */
function byteLength(s) {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * 从自然语言里抽出候选检索词（去重、保持出现顺序）。
 *
 * 为什么不能直接把整句丢给 trigram：trigram 的 MATCH 是**短语匹配**，
 * 「你上次说的那个部署脚本叫什么」这种句子在库里不可能作为连续子串出现，
 * 直接查必然 0 命中。所以要拆成短词再 OR。
 *
 * @param {string} text 原始查询
 * @returns {string[]} 候选词，含 2 字中文（供 LIKE 兜底用；trigram 用不了 3 字以下的词）
 */
export function extractKeywords(text) {
  const terms = []
  const seen = new Set()
  const push = (term) => {
    if (term.length < 2) return
    const key = term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(term)
  }

  // 拉丁词 / 数字
  for (const word of String(text).match(/[A-Za-z][A-Za-z0-9_.-]+/g) ?? []) push(word)

  // 中文连续片段：按 4→3→2 字滑窗切
  for (const run of String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []) {
    if (run.length <= 4) {
      push(run)
      for (let i = 0; i + 3 <= run.length; i++) push(run.slice(i, i + 3))
      for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2))
      continue
    }
    let added = 0
    for (const size of [4, 3]) {
      for (let i = 0; i + size <= run.length && added < 8; i += size === 4 ? 2 : 1) {
        push(run.slice(i, i + size))
        added++
      }
      if (added >= 8) break
    }
    // 长片段尾部再补 2 字词，留给 LIKE 兜底
    for (let i = 0; i + 2 <= run.length && i < 12; i += 2) push(run.slice(i, i + 2))
  }

  return terms
}

/**
 * 抽取式摘要：给一组消息挑最多 maxLines 句最有信息量的。
 * 打分 = 去重后的关键词数（越长越具体的句子分越高），用户发言略加权。
 * 不调模型，所以「摘要」只保证抓住字面重点，不做语义归纳 —— 这是零成本那一档。
 */
export function pickDigest(rows, { maxLines = 2, maxChars = 260 } = {}) {
  const scored = []
  for (const row of rows) {
    const weight = row.role === 'user' ? 1.25 : 1
    for (const sentence of splitSentences(row.body)) {
      const uniq = new Set(extractKeywords(sentence).filter((t) => t.length >= 2 && !DIGEST_STOP.has(t)))
      if (uniq.size < 2) continue
      scored.push({ text: sentence, words: uniq, score: uniq.size * weight })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  let used = 0
  for (const item of scored) {
    if (picked.length >= maxLines || used >= maxChars) break
    // 和已选句子高度重叠（共享一半以上关键词）就跳过，免得两句话说的是同一件事
    const near = picked.some((prev) => {
      let shared = 0
      for (const word of item.words) if (prev.words.has(word)) shared++
      return shared / Math.max(1, Math.min(prev.words.size, item.words.size)) > 0.5
    })
    if (near) continue
    const room = maxChars - used
    if (room < 20) break
    const text = item.text.length > room ? item.text.slice(0, room) + '…' : item.text
    picked.push({ text, words: item.words })
    used += text.length
  }
  return picked.map((item) => item.text).join(' / ')
}

/** 把一段正文切成候选短句（按中文标点与换行），去掉 markdown 记号和过短/过长的。 */
function splitSentences(text) {
  return String(text)
    .split(/[\n。！？；!?;]+/)
    .map((s) => s.trim().replace(/^[#>*\-–—\s]+/, '').trim())
    .filter((s) => s.length >= 12 && s.length <= 160)
}

/**
 * 把候选词拼成 FTS5 MATCH 表达式。
 *
 * trigram 分词器只索引 3 字符序列，**3 字以下的词在 MATCH 里永远不命中**，
 * 所以这里显式丢掉 2 字词（它们只在 LIKE 兜底里有用）。
 *
 * @param {string} text 原始查询
 * @returns {string} MATCH 表达式；没有可用词时返回空串（调用方改走 LIKE 兜底）
 */
export function buildMatchQuery(text) {
  return extractKeywords(text)
    .filter((term) => term.length >= 3)
    .slice(0, 14)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ')
}

/**
 * 只给 LIKE 补位用的短词表。
 *
 * 为什么要单独一套：trigram 至少要吃 3 个字符，而中文里最常见的重合恰好是
 * **2 字**（「杭州」「部署」）。查询「杭州那台机器部署要注意什么」与库里
 * 「部署流程……推到杭州的服务器」只共享两个 2 字词，FTS 永远 0 命中，
 * 但人一看就知道是同一条记忆。所以这类查询必须在短词上补一刀。
 *
 * 成本控制：补位只在「最近 N 条」的窗口内做 LIKE（见 searchRecent），
 * 不是全库扫描 —— 5GB 全表 LIKE 会慢到不可接受，而「最近提过的事」本身就是
 * 召回最想要的语义。
 *
 * @param {string} text
 * @param {number} [max] 最多返回几个词
 * @returns {string[]}
 */
export function likeKeywords(text, max = 12) {
  const out = []
  const seen = new Set()
  const push = (term) => {
    const key = term.toLowerCase()
    if (seen.has(key) || out.length >= max) return
    seen.add(key)
    out.push(term)
  }
  // 拉丁词优先：它们比中文双字词更具区分度
  for (const word of String(text).match(/[A-Za-z][A-Za-z0-9_.-]+/g) ?? []) {
    if (word.length >= 2) push(word)
  }
  // 中文片段按 2 字窗口铺开，跨片段轮流取，保证查询里前后两半都能贡献词
  const runs = String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []
  const bigrams = runs.map((run) => {
    const list = []
    for (let i = 0; i + 2 <= run.length; i += 1) list.push(run.slice(i, i + 2))
    return list
  })
  const longest = bigrams.reduce((n, list) => Math.max(n, list.length), 0)
  for (let col = 0; col < longest; col += 1) {
    for (const list of bigrams) {
      if (col < list.length) push(list[col])
      if (out.length >= max) return out
    }
  }
  return out
}

/** 从正文里摘一段摘要（召回注入和面板都用它，避免把整条记忆塞进上下文）。 */
/**
 * 记忆的「显著性」：像人一样，带决策、纠正、路径、错误码的句子更容易被重新想起。
 *
 * 纯启发式，不调模型 —— 所以它衡量的只是「字面上的重要性信号」，不是语义理解。
 * 分数落在 0~1：日常对话约 0.2，含「记住 / 必须 / 根因 / D:\ 路径 / 错误码」的约 0.6~0.9。
 */
const SALIENCE_RULES = [
  [/(记住|别再|不要再|必须|一定要|约定|规则|以后|每次|决定|结论|默认|方案)/g, 0.12],
  [/(坑|踩过|踩坑|报错|失败|原因|根因|问题|注意|小心|禁止|不能)/g, 0.08],
  [/([A-Za-z]:\\|\\\\|错误码|端口|版本|配置|路径|ENOENT|EACCES|SQLITE|exit code)/g, 0.06],
  [/(我喜欢|我习惯|我要|我不想|我不用|偏好|一律|统一|一般|通常)/g, 0.07],
]

export function salienceOf(text, role = 'user') {
  const body = String(text ?? '')
  if (!body) return 0
  let score = 0.15
  for (const [re, weight] of SALIENCE_RULES) {
    const found = body.match(re)
    if (found) score += weight * Math.min(3, found.length)
  }
  // 太短的是应答（「好」「继续」），太长的是粘贴的日志：两头都不该算「重要」。
  if (body.length >= 40 && body.length <= 1200) score += 0.05
  // 用户说的是事实源，助手说的是解释：同内容下用户的更值得召回。
  if (role === 'user') score += 0.05
  return Math.min(1, Number(score.toFixed(3)))
}

/**
 * 遗忘曲线：久未被召回的记忆降权，但显著性高的衰减得慢。
 *
 * 半衰期 = 45 天 + 300 天 × 显著性。最低保留 0.45 —— 是降权而不是删除：
 * 只要字面足够相关，旧记忆仍然排得上来，只是不再压过新记忆。
 */
export function decayFactor({ ts = 0, lastHit = 0, salience = 0, now = Date.now() } = {}) {
  const last = Math.max(Number(ts) || 0, Number(lastHit) || 0)
  if (!last) return 0.45
  const ageDays = Math.max(0, (Number(now) - last) / 86400000)
  const halfLife = 60 + 400 * Math.max(0, Math.min(1, Number(salience) || 0))
  return 0.45 + 0.55 * Math.exp(-ageDays / halfLife)
}

export function makeSnippet(body, query, maxChars = 220) {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  // 尽量从命中词附近开窗，读起来像「有出处的摘录」而不是随机截断
  const words = String(query ?? '')
    .match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}|[A-Za-z0-9_-]{3,}/g) ?? []
  let at = -1
  for (const word of words) {
    const idx = flat.indexOf(word)
    if (idx >= 0 && (at < 0 || idx < at)) at = idx
  }
  const start = at <= 0 ? 0 : Math.max(0, at - Math.floor(maxChars / 3))
  const slice = flat.slice(start, start + maxChars)
  return (start > 0 ? '…' : '') + slice + '…'
}

/**
 * 比 makeSnippet 更省字数的摘录：**取命中词所在的那一句**，而不是固定长度的窗口。
 *
 * 为什么：窗口式摘录不管有没有用都占满 maxChars（220 字），而真正有信息量的往往
 * 只有一句。按句取，长文平均只花 40~90 字，短句直接整句给，读起来也更像「摘录」。
 *
 * 兜底：整条里没有任何一句含命中词（纯靠 LIKE 补位命中）时，退回窗口式摘录。
 *
 * @param {string} body
 * @param {string} query
 * @param {number} [maxChars] 单条上限
 * @returns {string}
 */
export function makeFocusSnippet(body, query, maxChars = 160) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  if (flat.length <= maxChars) return flat
  // 用双字词打分，而不是整段查询：中文问句（「部署脚本叫什么」）在正文里不可能
  // 原样出现，只有拆成双字词才比得出「哪一句最贴题」。
  const words = likeKeywords(query, 12)
  if (words.length === 0) return makeSnippet(flat, query, maxChars)
  const sentences = flat.split(/(?<=[。！？；!?;\n])|\n/).map((s) => s.trim()).filter((s) => s.length >= 8)
  let bestAt = -1
  let bestHits = 0
  for (const [index, sentence] of sentences.entries()) {
    let hits = 0
    for (const word of words) if (sentence.includes(word)) hits++
    if (hits > bestHits) {
      bestHits = hits
      bestAt = index
    }
  }
  if (bestAt < 0) return makeSnippet(flat, query, maxChars)
  let best = sentences[bestAt]
  // 命中的句子太短（一行代码、一个标题）时，往后并一句上下文：光给半句反而读不懂。
  // 合并后仍不超上限才并，宁可少给也不能把预算撑爆。
  for (let next = bestAt + 1; next < sentences.length && best.length < maxChars * 0.6; next++) {
    const joined = `${best} ${sentences[next]}`
    if (joined.length > maxChars) break
    best = joined
  }
  // 单句本身就超长（整段没有中文标点的长文、代码块）：交给窗口式摘录，
  // 它会围绕命中词开窗，比硬截句首更像「摘录」。
  if (best.length > maxChars) return makeSnippet(flat, query, maxChars)
  return best
}

/**
 * 去掉互为重复的检索结果：两条记忆如果摘录**高度重合**（共享一半以上双字词），
 * 只留相关度更高的那条。重复注入等于把同一段话付两次 token。
 *
 * @param {Array<{id:number, snippet:string, score:number}>} results 已按相关度排好
 * @param {number} [threshold] 重合比例阈值
 * @returns {Array}
 */
export function dropDuplicates(results, threshold = 0.5) {
  const kept = []
  const sets = []
  for (const item of results) {
    const text = String(item.snippet ?? '')
    const words = new Set()
    const runs = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []
    for (const run of runs) for (let i = 0; i + 2 <= run.length; i++) words.add(run.slice(i, i + 2))
    for (const word of text.match(/[A-Za-z0-9_.-]{3,}/g) ?? []) words.add(word.toLowerCase())
    if (words.size === 0) {
      kept.push(item)
      sets.push(words)
      continue
    }
    let near = false
    for (const prev of sets) {
      if (prev.size === 0) continue
      let shared = 0
      for (const word of words) if (prev.has(word)) shared++
      if (shared / Math.min(prev.size, words.size) > threshold) {
        near = true
        break
      }
    }
    if (near) continue
    kept.push(item)
    sets.push(words)
  }
  return kept
}

/** 一条记忆的稳定指纹：同一条同角色内容全局只存一份，重复出现只加 hit 计数。 */
function fingerprint(role, body) {
  return createHash('sha256').update(role).update('\u0000').update(body).digest('hex').slice(0, 32)
}

export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} options.dbPath SQLite 文件路径（不存在会自动建目录）
   * @param {number} [options.maxBytes] 库体积硬上限，默认 5 GiB
   * @param {number} [options.maxBodyChars] 单条正文上限
   */
  constructor({ dbPath, maxBytes = 5 * 1024 ** 3, maxBodyChars = 40000 }) {
    this.dbPath = dbPath
    this.defaultMaxBytes = maxBytes
    this.maxBytes = maxBytes
    this.configMaxBodyChars = maxBodyChars
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    // WAL 让「边写边查」不互相阻塞；synchronous=NORMAL 在 WAL 下已足够安全，
    // 且不用每条消息一次 fsync（对话量上来后差异很明显）。
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    // 多个宿主进程可能同时开着同一个库；迁移（ALTER）要独占写锁，
    // 默认 busy_timeout = 0 会立刻 SQLITE_BUSY 失败。
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    // 老库升级：0.6.x 之前的 mem 表没有 mode 列。加列而不是重建，历史记忆默认算「长期」。
    // 注意顺序：先 ALTER 加列，再建 mem_mode 索引（索引不能写进 SCHEMA，见上面注释）。
    if (!this.hasColumn('mem', 'mode')) {
      this.db.exec("ALTER TABLE mem ADD COLUMN mode TEXT NOT NULL DEFAULT 'long'")
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS mem_mode ON mem(mode, ts)')
    // 0.10.0「人类式记忆」三因子（显著性 / 遗忘衰减 / 联想）都依赖这两列。
    // 老库没有它们：加列 + 一次性回填（rebuildHumanIndex），历史记忆不会被丢掉。
    if (!this.hasColumn('mem', 'salience')) {
      this.db.exec('ALTER TABLE mem ADD COLUMN salience REAL NOT NULL DEFAULT 0')
    }
    if (!this.hasColumn('mem', 'kw')) {
      this.db.exec("ALTER TABLE mem ADD COLUMN kw TEXT NOT NULL DEFAULT ''")
    }
    // sessions：这条记忆在哪些会话里出现过（去重后仍要能数「被重复提了几次」）。
    // 没有它，同一条被复述两次就只剩一行，巩固层看不出「跨会话反复出现」。
    if (!this.hasColumn('mem', 'sessions')) {
      this.db.exec("ALTER TABLE mem ADD COLUMN sessions TEXT NOT NULL DEFAULT ''")
    }
    this.stmtMetaGet = this.db.prepare('SELECT value FROM mem_meta WHERE key = ?')
    this.stmtMetaSet = this.db.prepare(
      'INSERT INTO mem_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    this.stmtMetaDel = this.db.prepare('DELETE FROM mem_meta WHERE key = ?')
    // 面板/工具里改过的容量要能活过重启，所以覆盖值落在库里，而不是只改内存。
    const override = this.readQuotaOverride()
    if (override !== null) this.maxBytes = override
    this.quotaSource = override === null ? 'config' : 'override'
    this.applyBodyBudget()
    this.stmtInsert = this.db.prepare(
      `INSERT INTO mem (ts, session, role, title, body, hash, bytes, chars, hits, last_hit, mode, salience, kw, sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    )
    this.stmtFindHash = this.db.prepare('SELECT id, sessions FROM mem WHERE hash = ?')
    this.stmtTouch = this.db.prepare('UPDATE mem SET hits = hits + 1, last_hit = ? WHERE id = ?')
    this.stmtFtsInsert = this.db.prepare('INSERT INTO mem_fts (rowid, body) VALUES (?, ?)')
    // 普通（非 contentless / 非 external content）FTS5 表直接 DELETE 即可；
    // 用 'delete' 指令式 INSERT 在这个形态下会报 "SQL logic error"。
    this.stmtFtsDelete = this.db.prepare('DELETE FROM mem_fts WHERE rowid = ?')
    this.stmtDelete = this.db.prepare('DELETE FROM mem WHERE id = ?')
    this.stmtBodyById = this.db.prepare('SELECT body FROM mem WHERE id = ?')
    this.stmtTotals = this.db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM mem')
    this.stmtOldest = this.db.prepare("SELECT id, chars FROM mem ORDER BY ts ASC, id ASC LIMIT 1")
    this.stmtRecent = this.db.prepare(
      'SELECT id, ts, session, role, title, body, hits, mode FROM mem ORDER BY ts DESC, id DESC LIMIT ?',
    )
    this.stmtHits = this.db.prepare('UPDATE mem SET hits = hits + 1, last_hit = ? WHERE id = ?')
    this.stmtRoleCounts = this.db.prepare('SELECT role, COUNT(*) AS n FROM mem GROUP BY role')
    this.stmtModeCounts = this.db.prepare('SELECT mode, COUNT(*) AS n FROM mem GROUP BY mode')
    this.stmtDeleteOnce = this.db.prepare("DELETE FROM mem WHERE id = ? AND mode = 'once'")
    this.stmtBounds = this.db.prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM mem')
    this.stmtCount = this.db.prepare('SELECT COUNT(*) AS n FROM mem')
    this.stmtRecentSessionKw = this.db.prepare(
      'SELECT id, kw FROM mem WHERE session = ? AND id <> ? ORDER BY ts DESC, id DESC LIMIT ?',
    )
    this.stmtAssocUpsert = this.db.prepare(
      'INSERT INTO mem_assoc (a, b, weight) VALUES (?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET weight = weight + excluded.weight',
    )
    this.stmtAssocNeighbors = this.db.prepare(
      `SELECT m.id, m.ts, m.session, m.role, m.title, m.body, m.mode, m.salience, a.weight
         FROM mem_assoc a JOIN mem m ON m.id = CASE WHEN a.a = ? THEN a.b ELSE a.a END
        WHERE (a.a = ? OR a.b = ?) AND m.id <> ?
        ORDER BY a.weight DESC LIMIT ?`,
    )
    this.stmtFactUpsert = this.db.prepare(
      `INSERT INTO mem_fact (key, body, hits, source, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET body = excluded.body, hits = excluded.hits,
                                     source = excluded.source, ts = excluded.ts`,
    )
    this.stmtFactAll = this.db.prepare('SELECT id, body, hits, source, ts FROM mem_fact ORDER BY hits DESC, ts DESC LIMIT ?')
    this.stmtFactCount = this.db.prepare('SELECT COUNT(*) AS n FROM mem_fact')
    // 老库一次性回填：显著性、关键词签名、联想边。几千条也是毫秒级，只跑一次。
    const filled = this.stmtMetaGet.get('human_v1')
    if (!filled) {
      try {
        this.rebuildHumanIndex()
        this.stmtMetaSet.run('human_v1', '1')
      } catch {
        /* 回填失败不影响主流程，下次打开再试 */
      }
    }
  }

  /**
   * 写入一条记忆。同样内容（同角色 + 同正文）只保留一份，重复出现只累加命中计数。
   * @returns {{id:number, created:boolean, bytes:number}}
   */
  save({ ts = Date.now(), session = '', role = 'user', title = '', body, maxChars, mode = 'long' } = {}) {
    const text = normalizeBody(body, maxChars ?? this.maxBodyChars)
    if (!text) return { id: 0, created: false, bytes: 0 }
    const keep = isValidMode(mode) ? mode : 'long'
    const hash = fingerprint(role, text)
    const existing = this.stmtFindHash.get(hash)
    if (existing) {
      this.stmtTouch.run(ts, existing.id)
      // 同一句话在**另一个会话**里又出现：不新开一行，只把会话记上去。
      // 巩固层靠这一列判断「跨会话反复出现」，去重不会把这个信号吃掉。
      const seen = String(existing.sessions ?? '').split(',').filter(Boolean)
      if (session && !seen.includes(session)) {
        seen.push(session)
        try {
          this.db.prepare('UPDATE mem SET sessions = ? WHERE id = ?').run(seen.slice(-8).join(','), existing.id)
        } catch {
          /* 记不上会话只是少一个信号 */
        }
      }
      return { id: Number(existing.id), created: false, bytes: 0 }
    }
    const bytes = byteLength(text)
    const salience = salienceOf(text, role)
    const kw = likeKeywords(text, 8).join(' ')
    const info = this.stmtInsert.run(
      ts, session, role, title.slice(0, 200), text, hash, bytes, text.length, keep, salience, kw, session,
    )
    const id = Number(info.lastInsertRowid)
    this.stmtFtsInsert.run(id, text)
    this.linkAssociations(id, session, kw)
    return { id, created: true, bytes, mode: keep, salience }
  }

  /**
   * 跨会话检索。
   *
   * @param {string} query 自然语言查询
   * @param {object} [options]
   * @param {number} [options.limit] 返回条数上限
   * @param {string} [options.excludeSession] 排除某个会话（召回时排除当前会话，免得复读）
   * @param {Set<number>|number[]} [options.excludeIds] 排除已注入过的 id
   * @returns {Array<{id:number, ts:number, session:string, role:string, title:string, body:string, snippet:string, score:number}>}
   */
  /**
   * 在「最近 window 条」的窗口内按短词 LIKE 补位。
   *
   * 为什么不扫全库：5GB 的全表 LIKE 是秒级操作，而召回每轮都要跑一次。
   * 窗口是有界成本（默认 2000 条，约几 MB），而「最近提过的事」正是召回
   * 最想找回的东西 —— 三年前的某句话和今天的输入重合两个汉字，本来也不该算命中。
   *
   * 排序用「命中了几个不同的词」而不是 SQL 里的时序：命中词多的更相关，
   * 这样「杭州」+「部署」双命中会排到只命中「部署」的前面。
   *
   * @returns {Array} 与 search() 同构的行
   */
  searchRecent(query, { limit = 5, excludeSession, excludeIds, scopeSession, window = 2000, beforeTs = 0, beforeSession = '', human = true, now = Date.now() } = {}) {
    const keywords = likeKeywords(query)
    if (keywords.length === 0) return []
    const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds ?? [])
    const filters = []
    const params = []
    if (excludeSession) {
      filters.push('m.session <> ?')
      params.push(excludeSession)
    }
    // 当前这一轮刚进来的用户消息不该被「召回」：它本来就在上下文里，取回来只是复读。
    // 只钉「本会话 + 这条时间戳及之后」的行，别的会话不受影响。
    if (beforeTs > 0) {
      if (beforeSession) {
        filters.push('NOT (m.ts > ? AND m.session = ?)')
        params.push(Number(beforeTs), String(beforeSession))
      } else {
        filters.push('m.ts < ?')
        params.push(Number(beforeTs))
      }
    }
    // multi（多次）只在它自己的会话里可见：别的会话检索不到，等于「关掉这个会话就没了」。
    if (scopeSession) {
      filters.push("(m.mode = 'long' OR m.session = ?)")
      params.push(scopeSession)
    }
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : ''
    const likeClause = keywords.map(() => 'm.body LIKE ?').join(' OR ')
    const likeParams = keywords.map((word) => `%${word}%`)
    const sql = `SELECT m.id, m.ts, m.session, m.role, m.title, m.body, m.mode, m.salience, m.last_hit, m.hits, 0 AS score
                 FROM (SELECT * FROM mem ORDER BY ts DESC, id DESC LIMIT ?) m
                 WHERE (${likeClause})${where}
                 ORDER BY m.ts DESC LIMIT ?`
    let rows = []
    try {
      rows = this.db.prepare(sql).all(window, ...likeParams, ...params, 400)
    } catch {
      return []
    }
    const scored = []
    for (const row of rows) {
      const id = Number(row.id)
      if (skip.has(id)) continue
      const body = String(row.body ?? '')
      let hits = 0
      for (const word of keywords) if (body.includes(word)) hits++
      // 补位命中只有 0.45~0.60 的相关度：它是「不够 trigram 门槛」的次优证据，
      // 显著性再高也不该压过一条精确命中。
      const relevance = 0.45 + 0.15 * (hits / Math.max(1, keywords.length))
      const weight = human
        ? relevance * (0.55 + 0.45 * (Number(row.salience) || 0)) * decayFactor({
            ts: Number(row.ts),
            lastHit: Number(row.last_hit),
            salience: Number(row.salience),
            now,
          })
        : 0
      scored.push({ row, hits, weight })
    }
    if (human) {
      // 三因子排序：字面相关 × 显著性 × 遗忘衰减；同分再按「命中了几个词」和新旧。
      scored.sort((a, b) => b.weight - a.weight || b.hits - a.hits || Number(b.row.ts) - Number(a.row.ts))
      return scored.slice(0, limit).map((item) => ({ ...item.row, score: item.weight, __like: true }))
    }
    scored.sort((a, b) => b.hits - a.hits || Number(b.row.ts) - Number(a.row.ts))
    return scored.slice(0, limit).map((item) => ({ ...item.row, __like: true }))
  }

  /**
   * 跨会话检索。两段式：先 FTS5 trigram（精确、可排序），不足则用短词补位。
   *
   * @param {string} query 自然语言查询
   * @param {object} [options]
   * @param {number} [options.limit] 返回条数上限
   * @param {string} [options.excludeSession] 排除某个会话（召回时排除当前会话，免得复读）
   * @param {Set<number>|number[]} [options.excludeIds] 排除已注入过的 id
   * @returns {Array<{id:number, ts:number, session:string, role:string, title:string, body:string, snippet:string, score:number}>}
   */
  search(query, { limit = 5, offset = 0, excludeSession, excludeIds, scopeSession, beforeTs = 0, beforeSession = '', snippetChars = 160, human = true, now = Date.now() } = {}) {
    // offset 让同一句话可以「翻页」：命中很多时不必一次全塞进上下文。
    const skipCount = Math.max(0, Math.min(1000, Math.floor(Number(offset) || 0)))
    const want = limit + skipCount
    const match = buildMatchQuery(query)
    const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds ?? [])
    const filters = []
    const params = []
    if (excludeSession) {
      filters.push('m.session <> ?')
      params.push(excludeSession)
    }
    if (beforeTs > 0) {
      if (beforeSession) {
        filters.push('NOT (m.ts > ? AND m.session = ?)')
        params.push(Number(beforeTs), String(beforeSession))
      } else {
        filters.push('m.ts < ?')
        params.push(Number(beforeTs))
      }
    }
    if (scopeSession) {
      filters.push("(m.mode = 'long' OR m.session = ?)")
      params.push(scopeSession)
    }
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : ''
    const rows = []
    if (match) {
      const sql = `SELECT m.id, m.ts, m.session, m.role, m.title, m.body, m.mode, m.salience, m.last_hit, m.hits,
                        bm25(mem_fts) AS score
                   FROM mem_fts JOIN mem m ON m.id = mem_fts.rowid
                   WHERE mem_fts MATCH ?${where}
                   ORDER BY score LIMIT ?`
      try {
        for (const row of this.db.prepare(sql).all(match, ...params, want + skip.size + 5)) rows.push(row)
      } catch {
        // MATCH 表达式被 FTS5 拒绝时静默降级（不能让检索失败拖垮整轮对话）
      }
    }
    // 不足则补位：覆盖「只有 2 字重合」「查询短于 3 字」这些 trigram 的结构性盲区
    if (rows.length < want) {
      const found = new Set(rows.map((row) => Number(row.id)))
      for (const row of this.searchRecent(query, {
        limit: want + skip.size + 5,
        ...(excludeSession ? { excludeSession } : {}),
        ...(scopeSession ? { scopeSession } : {}),
        ...(beforeTs > 0 ? { beforeTs, beforeSession } : {}),
        excludeIds: skip,
        human,
      })) {
        const id = Number(row.id)
        if (found.has(id)) continue
        found.add(id)
        rows.push(row)
      }
    }
    const out = []
    let ftsRank = 0
    for (const row of rows) {
      const id = Number(row.id)
      if (skip.has(id)) continue
      // 相关度：FTS 命中按名次给分（首名 0.85，往后每名 -0.03，地板 0.50）；
      // LIKE 补位用 searchRecent 已算好的分（0.45~0.60）。
      let relevance
      if (row.__like) {
        relevance = Number(row.score) || 0.5
      } else {
        relevance = Math.max(0.5, 0.85 - ftsRank * 0.03)
        ftsRank += 1
      }
      const salience = Number(row.salience) || 0
      const weight = human
        ? relevance * (0.55 + 0.45 * salience) * decayFactor({
            ts: Number(row.ts),
            lastHit: Number(row.last_hit),
            salience,
            now,
          })
        : relevance
      out.push({
        id,
        ts: Number(row.ts),
        session: String(row.session ?? ''),
        role: String(row.role ?? ''),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        mode: String(row.mode ?? 'long'),
        salience,
        snippet: makeFocusSnippet(String(row.body ?? ''), query, snippetChars),
        score: Number(weight.toFixed(4)),
      })
      if (out.length >= want) break
    }
    // 三因子重排：显著性高、又没过期的记忆可以越过一条「字面更沾边但毫无信息量」的旧消息。
    // 只在 human 模式下做；关掉时保持 FTS 名次 + 补位次序。
    if (human) out.sort((a, b) => b.score - a.score || b.ts - a.ts)
    return skipCount > 0 ? out.slice(skipCount, skipCount + limit) : out
  }

  /** 标记这些记忆被用上了（影响面板的「热度」排序与淘汰优先级）。 */
  markUsed(ids, ts = Date.now()) {
    for (const id of ids) {
      try {
        this.stmtHits.run(ts, id)
      } catch {
        /* 已删除的 id 忽略 */
      }
    }
  }

  /**
   * 「单次」模式的记忆被召回一次后立刻抹掉：先删主表再删 FTS 镜像。
   * 召回侧注入完成之后调用，保证它确实进过一次上下文才消失。
   * @returns {number} 实际删除条数
   */
  consumeOnce(ids) {
    let removed = 0
    for (const raw of ids ?? []) {
      const id = Number(raw)
      if (!Number.isFinite(id) || id <= 0) continue
      try {
        const info = this.stmtDeleteOnce.run(id)
        if (Number(info?.changes ?? 0) > 0) {
          this.stmtFtsDelete.run(id)
          removed++
        }
      } catch {
        /* 已被删掉的忽略 */
      }
    }
    return removed
  }

  /**
   * 清理会过期的记忆：`multi`（本会话多次）超过 TTL、`once` 一直没被召回超过兜底期。
   * 在 apply 时调一次即可 —— 进程重启意味着上个会话已经结束。
   * @returns {{multi:number, once:number}}
   */
  purgeTransient({ now = Date.now(), multiTtlMs = MULTI_TTL_MS, onceTtlMs = ONCE_TTL_MS } = {}) {
    const out = { multi: 0, once: 0 }
    for (const [mode, ttl, key] of [
      ['multi', multiTtlMs, 'multi'],
      ['once', onceTtlMs, 'once'],
    ]) {
      const rows = this.db.prepare('SELECT id FROM mem WHERE mode = ? AND ts < ?').all(mode, now - ttl)
      for (const row of rows) {
        try {
          this.db.prepare('DELETE FROM mem WHERE id = ?').run(Number(row.id))
          this.stmtFtsDelete.run(Number(row.id))
          out[key]++
        } catch {
          /* 忽略 */
        }
      }
    }
    return out
  }

  /** 表里有没有这一列（用于老库迁移判断，避免「列已存在」和「真的失败」分不清）。 */
  hasColumn(table, column) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all()
    return rows.some((row) => row.name === column)
  }

  /**
   * 单条正文上限必须远小于配额：淘汰是「删最旧的直到低于水位」，若某一行本身
   * 就比水位还大，它会连带把其它行一起删光。按配额 5% 反推字符数
   * （中文 UTF-8 约 3 字节/字），下限 200 字，避免配额很小时单条被压得没法用。
   */
  applyBodyBudget() {
    const budgetChars = Math.floor(this.maxBytes / 20 / 3)
    this.maxBodyChars = Math.max(200, Math.min(this.configMaxBodyChars, budgetChars))
  }

  /** 库里存着的容量覆盖值；没有或已损坏则返回 null（回落到配置值）。 */
  readQuotaOverride() {
    try {
      const row = this.stmtMetaGet.get('quota_bytes')
      if (!row) return null
      const n = Number(row.value)
      if (!Number.isFinite(n) || n < MIN_BYTES || n > MAX_BYTES) return null
      return n
    } catch {
      return null
    }
  }

  /**
   * 调整容量：立刻生效 + 落库持久化（重启后仍然是你设的值，不会被 config 覆盖回去）。
   * 缩小容量会立即淘汰超出的最旧记忆 —— 这是配额语义本身要求的，不是副作用。
   * @param {number} bytes 目标字节数
   * @param {{persist?: boolean}} [options] persist=false 表示只改本次进程
   */
  setQuotaBytes(bytes, { persist = true } = {}) {
    const n = Number(bytes)
    if (!Number.isFinite(n) || n < MIN_BYTES || n > MAX_BYTES) {
      throw new RangeError(
        `容量需在 ${(MIN_BYTES / 1024 ** 3).toFixed(2)}GB ~ ${(MAX_BYTES / 1024 ** 3).toFixed(0)}GB 之间`,
      )
    }
    this.maxBytes = Math.round(n)
    this.applyBodyBudget()
    if (persist) {
      this.stmtMetaSet.run('quota_bytes', String(this.maxBytes))
      this.quotaSource = 'override'
    } else {
      this.stmtMetaDel.run('quota_bytes')
      this.quotaSource = 'config'
    }
    const removed = this.enforceQuota()
    return { ...this.stats(), removed }
  }

  /** 按 GB 调整容量；非法值抛 RangeError。 */
  setQuotaGB(gb, options) {
    const bytes = gigabytesToBytes(gb)
    if (bytes === null) {
      throw new RangeError(
        `容量需在 ${(MIN_BYTES / 1024 ** 3).toFixed(2)}GB ~ ${(MAX_BYTES / 1024 ** 3).toFixed(0)}GB 之间`,
      )
    }
    return this.setQuotaBytes(bytes, options)
  }

  /** 丢掉覆盖值，回到配置文件里的容量。 */
  clearQuotaOverride() {
    this.stmtMetaDel.run('quota_bytes')
    this.maxBytes = this.defaultMaxBytes
    this.quotaSource = 'config'
    this.applyBodyBudget()
    return this.stats()
  }

  /** 库体积与条数统计，面板与 memory_stats 共用。 */
  stats() {
    const totals = this.stmtTotals.get() ?? { rows: 0, bytes: 0 }
    const bounds = this.stmtBounds.get() ?? {}
    const byRole = {}
    for (const row of this.stmtRoleCounts.all()) byRole[String(row.role)] = Number(row.n)
    const byMode = {}
    for (const row of this.stmtModeCounts.all()) byMode[String(row.mode ?? 'long')] = Number(row.n)
    const mb = 1024 * 1024
    return {
      dbPath: this.dbPath,
      rows: Number(totals.rows),
      bytes: Number(totals.bytes),
      usedMB: Number((Number(totals.bytes) / mb).toFixed(2)),
      maxMB: Number((this.maxBytes / mb).toFixed(0)),
      maxGB: Number((this.maxBytes / 1024 ** 3).toFixed(2)),
      quotaSource: this.quotaSource ?? 'config',
      presetsGB: SIZE_PRESETS,
      usedPercent: Number(((Number(totals.bytes) / this.maxBytes) * 100).toFixed(2)),
      byRole,
      byMode,
      facts: (() => {
        try {
          return Number(this.stmtFactCount.get()?.n ?? 0)
        } catch {
          return 0
        }
      })(),
      oldest: bounds.oldest ? Number(bounds.oldest) : null,
      newest: bounds.newest ? Number(bounds.newest) : null,
    }
  }

  /** 最近 N 条记忆，面板「最近记忆」列表用。 */
  recent(limit = 20) {
    return this.stmtRecent.all(limit).map((row) => ({
      id: Number(row.id),
      ts: Number(row.ts),
      session: String(row.session ?? ''),
      role: String(row.role ?? ''),
      title: String(row.title ?? ''),
      snippet: makeSnippet(String(row.body ?? ''), '', 160),
      chars: Number(row.chars ?? String(row.body ?? '').length),
      hits: Number(row.hits ?? 0),
      mode: String(row.mode ?? 'long'),
    }))
  }

  /**
   * 按天/按会话翻页取目录条目。目录 = 面板上给人看的索引，
   * 所以只回轻量字段（不含正文），正文由 getById 单条取 —— 一次 100 条也不该把几 MB 拉进浏览器。
   *
   * @param {{limit?: number, offset?: number, day?: string, session?: string}} options
   *   day 形如 '2026-10-20'（本地时区，与面板显示一致）
   */
  recentPage({ limit = 20, offset = 0, day, session } = {}) {
    const take = Math.max(1, Math.min(200, Number(limit) || 20))
    const skip = Math.max(0, Number(offset) || 0)
    const where = []
    const args = []
    if (day) {
      // ts 是毫秒；按本地日界算区间，避免 SQLite 的 date() 用 UTC 把凌晨的记录算到前一天
      const start = new Date(`${day}T00:00:00`).getTime()
      if (Number.isFinite(start)) {
        where.push('ts >= ? AND ts < ?')
        args.push(start, start + 86400000)
      }
    }
    if (session) {
      where.push('session = ?')
      args.push(String(session))
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM mem ${clause}`).get(...args)?.n ?? 0)
    const rows = this.db
      .prepare(
        `SELECT id, ts, session, role, title, body, chars, hits, mode FROM mem ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, take, skip)
      .map((row) => ({
        id: Number(row.id),
        ts: Number(row.ts),
        session: String(row.session ?? ''),
        role: String(row.role ?? ''),
        title: String(row.title ?? ''),
        snippet: makeSnippet(String(row.body ?? ''), '', 160),
        chars: Number(row.chars ?? String(row.body ?? '').length),
        hits: Number(row.hits ?? 0),
        mode: String(row.mode ?? 'long'),
      }))
    return { total, offset: skip, limit: take, rows }
  }

  /** 单条全文（面板点开某一项时用）。找不到返回 null。 */
  getById(id) {
    const row = this.db
      .prepare('SELECT id, ts, session, role, title, body, chars, bytes, hits, last_hit, mode FROM mem WHERE id = ?')
      .get(Number(id))
    if (!row) return null
    return {
      id: Number(row.id),
      ts: Number(row.ts),
      session: String(row.session ?? ''),
      role: String(row.role ?? ''),
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      chars: Number(row.chars ?? 0),
      bytes: Number(row.bytes ?? 0),
      hits: Number(row.hits ?? 0),
      lastHit: Number(row.last_hit ?? 0),
      mode: String(row.mode ?? 'long'),
    }
  }

  /**
   * 按需分段读一条记忆的正文。
   * 存在的意义：库可以有 5GB，窗口只有十几万字 —— 靠「一次读一小段」把任意长度的记忆变成
   * 可顺序访问的流，而不是只在召回时截一个 220 字摘要。next 为 null 表示已读到末尾。
   */
  open(id, { offset = 0, chars = 2400 } = {}) {
    const row = this.getById(id)
    if (!row) return null
    const total = row.body.length
    const step = Math.max(120, Math.min(12000, Math.floor(Number(chars) || 2400)))
    const from = Math.max(0, Math.min(total, Math.floor(Number(offset) || 0)))
    const to = Math.min(total, from + step)
    return {
      id: row.id,
      ts: row.ts,
      session: row.session,
      role: row.role,
      title: row.title,
      mode: row.mode,
      total,
      offset: from,
      end: to,
      next: to < total ? to : null,
      body: row.body.slice(from, to),
    }
  }

  /**
   * 目录摘要：按天 + 按会话两种切分，各自带条数与最近时间。
   * 「按天」用本地时区格式化，和面板上显示的时间戳口径一致。
   */
  catalog({ days = 30, sessions = 20 } = {}) {
    const toDay = (ts) => {
      const d = new Date(Number(ts))
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    const byDay = new Map()
    for (const row of this.db.prepare('SELECT ts, bytes FROM mem').all()) {
      const key = toDay(row.ts)
      const cur = byDay.get(key) ?? { day: key, count: 0, bytes: 0, newest: 0 }
      cur.count += 1
      cur.bytes += Number(row.bytes ?? 0)
      cur.newest = Math.max(cur.newest, Number(row.ts) || 0)
      byDay.set(key, cur)
    }
    const bySession = this.db
      .prepare(
        'SELECT session, COUNT(*) AS n, MAX(ts) AS newest FROM mem GROUP BY session ORDER BY newest DESC LIMIT ?',
      )
      .all(Math.max(1, Math.min(200, Number(sessions) || 20)))
      .map((row) => ({
        session: String(row.session ?? ''),
        count: Number(row.n ?? 0),
        newest: Number(row.newest ?? 0),
      }))
    return {
      total: Number(this.stmtCount.get()?.n ?? 0),
      days: [...byDay.values()].sort((a, b) => b.newest - a.newest).slice(0, Math.max(1, Number(days) || 30)),
      sessions: bySession,
    }
  }

  /**
   * 每个过去会话压成几行要点（抽取式，不调模型）。
   * 这是「累积记忆」层：原文留在库里按需分页读，而新会话第一轮只需读这几行，
   * 就知道以前聊过什么 —— 压缩率决定能累积多少个会话，检索层决定每轮读多少。
   *
   * @param {object} [options]
   * @param {number} [options.limit] 最多给几个会话
   * @param {string} [options.excludeSession] 排除当前会话（它正在上下文里，不用摘要）
   * @param {number} [options.perSessionLines] 每个会话最多几句
   */
  sessionDigests({ limit = 6, excludeSession, perSessionLines = 2, perSessionChars = 260 } = {}) {
    const take = Math.max(1, Math.min(30, Number(limit) || 6))
    const self = excludeSession ? String(excludeSession) : ''
    const heads = this.db
      .prepare(
        `SELECT session, COUNT(*) AS n, MAX(ts) AS newest FROM mem
         ${self ? 'WHERE session <> ?' : ''}
         GROUP BY session ORDER BY newest DESC LIMIT ?`,
      )
      .all(...(self ? [self] : []), take + 1)
    const rowsOf = this.db.prepare(
      'SELECT role, body, ts FROM mem WHERE session = ? ORDER BY ts DESC LIMIT 40',
    )
    const out = []
    for (const head of heads) {
      if (out.length >= take) break
      const rows = rowsOf.all(String(head.session ?? '')).reverse()
      const digest = pickDigest(rows, { maxLines: perSessionLines, maxChars: perSessionChars })
      out.push({
        session: String(head.session ?? ''),
        count: Number(head.n ?? 0),
        newest: Number(head.newest ?? 0),
        digest,
      })
    }
    return out
  }

  // 某个会话最近 N 条的 id。召回要用它把「刚说过的内容」排除掉 ——
  // 那些内容还在上下文里，重复注入只会挤占预算；更早的（尤其被压缩掉的）才值得取回。
  recentIdsBySession(session, limit = 40) {
    if (!session || limit <= 0) return [] // 0 = 不排除任何本会话内容（调用方明确要求全量召回）
    return this.db
      .prepare('SELECT id FROM mem WHERE session = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(String(session), Math.max(1, Math.min(500, Number(limit) || 40)))
      .map((row) => Number(row.id))
  }

  deleteById(id) {
    const row = this.stmtBodyById.get(id)
    if (!row) return false
    this.stmtFtsDelete.run(id)
    this.stmtDelete.run(id)
    return true
  }

  /**
   * 把库压回配额以内：从最旧的开始删，直到低于水位（默认 90%）。
   * 只在写入后调用，且一旦达标立刻返回，所以正常使用时不会触发全表扫描。
   *
   * 硬约束：**至少保留最新一条**。哪怕调用方配了离谱的 maxBytes，
   * 也不该出现「刚存的东西立刻被自己挤掉」这种结果。
   *
   * @returns {number} 删掉的条数
   */
  enforceQuota(highWatermark = 0.9) {
    let totals = this.stmtTotals.get() ?? { bytes: 0 }
    let bytes = Number(totals.bytes)
    if (bytes <= this.maxBytes) return 0
    const target = Math.floor(this.maxBytes * highWatermark)
    let removed = 0
    while (bytes > target) {
      const remaining = Number(this.stmtCount.get()?.n ?? 0)
      if (remaining <= 1) break
      const oldest = this.stmtOldest.get()
      if (!oldest) break
      const id = Number(oldest.id)
      const body = this.stmtBodyById.get(id)
      this.stmtFtsDelete.run(id)
      this.stmtDelete.run(id)
      bytes -= byteLength(String(body?.body ?? ''))
      removed++
    }
    return removed
  }

  /**
   * 联想建边：新记忆与同会话最近 12 条共享两个以上关键词就连一条边。
   * 为什么是「同会话近邻」而不是全库比对：人会先联想同一次经历里的细节，
   * 而且近邻是有界成本（最多 12 次集合求交），不随库变大。
   */
  linkAssociations(id, session, kw) {
    if (!session) return 0
    const mine = new Set(String(kw ?? '').split(' ').filter(Boolean))
    if (mine.size < 2) return 0
    let linked = 0
    let recent = []
    try {
      recent = this.stmtRecentSessionKw.all(session, id, 12)
    } catch {
      return 0
    }
    for (const row of recent) {
      const theirs = String(row.kw ?? '').split(' ').filter(Boolean)
      if (theirs.length < 2) continue
      let shared = 0
      for (const word of theirs) if (mine.has(word)) shared++
      if (shared < 2) continue
      const a = Math.min(id, Number(row.id))
      const b = Math.max(id, Number(row.id))
      try {
        this.stmtAssocUpsert.run(a, b, shared)
        linked++
      } catch {
        /* 单条边写失败不算错 */
      }
    }
    return linked
  }

  /**
   * 联想扩展：取每条命中记忆最强的邻居（默认只要 1 条），模拟「顺着想起」。
   * 刻意只取 1 条 —— 联想的价值是「提醒还有另一条路」，不是再多塞几条。
   */
  withAssociations(results, { limit = 1, scopeSession, excludeSession, snippetChars = 120, now = Date.now() } = {}) {
    if (!Array.isArray(results) || results.length === 0 || limit <= 0) return results
    const have = new Set(results.map((item) => item.id))
    const extra = []
    for (const hit of results) {
      let neighbors = []
      try {
        neighbors = this.stmtAssocNeighbors.all(hit.id, hit.id, hit.id, hit.id, 8)
      } catch {
        continue
      }
      for (const row of neighbors) {
        const id = Number(row.id)
        if (have.has(id)) continue
        const mode = String(row.mode ?? 'long')
        const session = String(row.session ?? '')
        if (mode === 'multi' && scopeSession && session !== scopeSession) continue
        if (excludeSession && session === excludeSession) continue
        have.add(id)
        extra.push({
          id,
          ts: Number(row.ts),
          session,
          role: String(row.role ?? ''),
          title: String(row.title ?? ''),
          body: String(row.body ?? ''),
          mode,
          salience: Number(row.salience) || 0,
          kind: 'assoc',
          via: hit.id,
          snippet: makeFocusSnippet(String(row.body ?? ''), String(hit.title ?? ''), snippetChars),
          score: Number(row.weight) || 0,
        })
        break
      }
      if (extra.length >= limit) break
    }
    return results.concat(extra)
  }

  /** 巩固层的读取侧：按关键词找事实卡。结构与检索结果同构（id 指向原文，可 memory_open）。 */
  searchFacts(query, { limit = 2 } = {}) {
    const keywords = likeKeywords(query, 10)
    if (keywords.length === 0) return []
    let rows = []
    try {
      rows = this.stmtFactAll.all(500)
    } catch {
      return []
    }
    const scored = []
    for (const row of rows) {
      const body = String(row.body ?? '')
      let hits = 0
      for (const word of keywords) if (body.includes(word)) hits++
      if (hits === 0) continue
      scored.push({ row, hits })
    }
    scored.sort((a, b) => b.hits - a.hits || Number(b.row.hits) - Number(a.row.hits))
    return scored.slice(0, limit).map(({ row, hits }) => ({
      id: Number(row.source),
      ts: Number(row.ts),
      session: '',
      role: 'user',
      title: '',
      body: String(row.body ?? ''),
      mode: 'long',
      kind: 'fact',
      salience: 1,
      snippet: String(row.body ?? '').slice(0, 200),
      score: 1 + hits,
    }))
  }

  /**
   * 巩固层（模仿「睡眠时把情景压成语义记忆」）：
   * 把长期模式里「关键词签名相同、且横跨 ≥2 个会话」的内容抽成事实卡。
   * 纯抽取式、不调模型 —— 它只能抓「反复出现的字面重点」，不是真正的归纳。
   */
  consolidate({ minSessions = 2, minRows = 2, maxCards = 200 } = {}) {
    let rows = []
    try {
      rows = this.db
        .prepare(
          `SELECT * FROM (
             SELECT id, ts, session, sessions, body, kw, salience, ts AS stamp
             FROM mem WHERE mode = 'long' AND kw <> ''
             ORDER BY ts DESC LIMIT 4000
           ) ORDER BY stamp ASC`,
        )
        .all()
    } catch {
      return { cards: 0, groups: 0 }
    }
    // 聚类用「关键词对」做桶 + 并查集：两条内容只要**共享任意两个关键词**就落进同一个桶。
    // 早期按「最长三个词」拼签名，几乎每条都能拼出独一无二的签名，51 条能分出 51 组，
    // 等于什么都没聚起来。
    const byId = new Map()
    const parent = new Map()
    const find = (start) => {
      let x = start
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)))
        x = parent.get(x)
      }
      return x
    }
    const union = (a, b) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(rb, ra)
    }
    const buckets = new Map()
    const wordsOf = new Map()
    for (const row of rows) {
      const id = Number(row.id)
      byId.set(id, row)
      parent.set(id, id)
      const words = [...new Set(String(row.kw ?? '').split(' ').filter((word) => word.length >= 2))].slice(0, 6)
      wordsOf.set(id, words)
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) {
          const key = words[i] < words[j] ? `${words[i]}|${words[j]}` : `${words[j]}|${words[i]}`
          const list = buckets.get(key)
          if (list) list.push(id)
          else buckets.set(key, [id])
        }
      }
    }
    for (const list of buckets.values()) {
      for (let i = 1; i < list.length; i++) union(list[0], list[i])
    }
    const groups = new Map()
    for (const [id, row] of byId) {
      const root = find(id)
      const group = groups.get(root) ?? { rows: [], sessions: new Set() }
      group.rows.push(row)
      for (const session of `${row.session},${row.sessions ?? ''}`.split(',').filter(Boolean)) {
        group.sessions.add(session)
      }
      groups.set(root, group)
    }
    let cards = 0
    for (const group of groups.values()) {
      if (group.sessions.size < minSessions || group.rows.length < minRows) continue
      const ordered = group.rows.slice().sort((a, b) => b.salience - a.salience || b.ts - a.ts)
      // 卡片的「共同关键词」= 组内前三条的关键词交集，比单个组员的签名更能代表整组。
      const shared = wordsOf.get(Number(ordered[0].id)) ?? []
      const words = shared
        .filter((word) => ordered.slice(0, 3).filter((row) => (wordsOf.get(Number(row.id)) ?? []).includes(word)).length >= 2)
        .sort((a, b) => b.length - a.length)
        .slice(0, 3)
      const key = (words.length >= 2 ? words : shared.slice(0, 3)).sort().join('|')
      let text = ''
      for (const row of ordered) {
        for (const sentence of splitSentences(row.body)) {
          let hits = 0
          for (const word of words.length >= 2 ? words : shared) if (sentence.includes(word)) hits++
          if (hits >= 2 && sentence.length >= 10) {
            text = sentence.length > 240 ? `${sentence.slice(0, 240)}…` : sentence
            break
          }
        }
        if (text) break
      }
      if (!text) text = String(ordered[0].body ?? '').slice(0, 200)
      if (!text) continue
      const keyHash = createHash('sha1').update(key || String(ordered[0].id)).digest('hex').slice(0, 16)
      try {
        this.stmtFactUpsert.run(keyHash, text, group.rows.length, Number(ordered[0].id), Number(ordered[0].ts))
        cards++
      } catch {
        /* 单张卡片失败不影响其余 */
      }
      if (cards >= maxCards) break
    }
    return { cards, groups: groups.size }
  }

  /** 老库回填：显著性、关键词签名、联想边。构造时按 meta 标记只跑一次。 */
  rebuildHumanIndex({ maxRows = 5000 } = {}) {
    let rows = []
    try {
      rows = this.db.prepare("SELECT id, ts, session, role, body FROM mem WHERE kw = '' ORDER BY id ASC LIMIT ?").all(maxRows)
    } catch {
      return 0
    }
    const update = this.db.prepare('UPDATE mem SET salience = ?, kw = ?, sessions = ? WHERE id = ?')
    let filled = 0
    for (const row of rows) {
      const body = String(row.body ?? '')
      const session = String(row.session ?? '')
      update.run(salienceOf(body, String(row.role ?? 'user')), likeKeywords(body, 8).join(' '), session, Number(row.id))
      filled++
    }
    // 边：同一会话内按时间顺序，每条与前面 12 条比一次（与实时写入同一口径）。
    try {
      const sessions = this.db.prepare("SELECT DISTINCT session FROM mem WHERE session <> ''").all()
      for (const { session } of sessions) {
        const list = this.db
          .prepare('SELECT id, kw FROM mem WHERE session = ? ORDER BY ts ASC, id ASC LIMIT 400')
          .all(String(session))
        for (let i = 0; i < list.length; i++) {
          const mine = new Set(String(list[i].kw ?? '').split(' ').filter(Boolean))
          if (mine.size < 2) continue
          for (let j = Math.max(0, i - 12); j < i; j++) {
            const theirs = String(list[j].kw ?? '').split(' ').filter(Boolean)
            if (theirs.length < 2) continue
            let shared = 0
            for (const word of theirs) if (mine.has(word)) shared++
            if (shared < 2) continue
            this.stmtAssocUpsert.run(Number(list[j].id), Number(list[i].id), shared)
          }
        }
      }
    } catch {
      /* 边建不出来只是少了联想，不影响检索与召回 */
    }
    return filled
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }
}