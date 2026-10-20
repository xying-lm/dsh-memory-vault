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
  last_hit INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_hash ON mem(hash);
CREATE INDEX IF NOT EXISTS mem_ts ON mem(ts);
CREATE INDEX IF NOT EXISTS mem_session ON mem(session, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  body,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS mem_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 配额允许区间：50MB ~ 200GB。上限不是技术限制，是避免一次误配把整块盘写满。 */
export const MIN_BYTES = 50 * 1024 * 1024
export const MAX_BYTES = 200 * 1024 ** 3
/** 常用档位（GB）。自定义容量走同一个漂移校验。 */
export const SIZE_PRESETS = [1, 5, 10, 20, 50]

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
    this.db.exec(SCHEMA)
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
      `INSERT INTO mem (ts, session, role, title, body, hash, bytes, chars, hits, last_hit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    this.stmtFindHash = this.db.prepare('SELECT id FROM mem WHERE hash = ?')
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
      'SELECT id, ts, session, role, title, body, hits FROM mem ORDER BY ts DESC, id DESC LIMIT ?',
    )
    this.stmtHits = this.db.prepare('UPDATE mem SET hits = hits + 1, last_hit = ? WHERE id = ?')
    this.stmtRoleCounts = this.db.prepare('SELECT role, COUNT(*) AS n FROM mem GROUP BY role')
    this.stmtBounds = this.db.prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM mem')
    this.stmtCount = this.db.prepare('SELECT COUNT(*) AS n FROM mem')
  }

  /**
   * 写入一条记忆。同样内容（同角色 + 同正文）只保留一份，重复出现只累加命中计数。
   * @returns {{id:number, created:boolean, bytes:number}}
   */
  save({ ts = Date.now(), session = '', role = 'user', title = '', body, maxChars } = {}) {
    const text = normalizeBody(body, maxChars ?? this.maxBodyChars)
    if (!text) return { id: 0, created: false, bytes: 0 }
    const hash = fingerprint(role, text)
    const existing = this.stmtFindHash.get(hash)
    if (existing) {
      this.stmtTouch.run(ts, existing.id)
      return { id: Number(existing.id), created: false, bytes: 0 }
    }
    const bytes = byteLength(text)
    const info = this.stmtInsert.run(ts, session, role, title.slice(0, 200), text, hash, bytes, text.length)
    const id = Number(info.lastInsertRowid)
    this.stmtFtsInsert.run(id, text)
    return { id, created: true, bytes }
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
  searchRecent(query, { limit = 5, excludeSession, excludeIds, window = 2000 } = {}) {
    const keywords = likeKeywords(query)
    if (keywords.length === 0) return []
    const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds ?? [])
    const filters = []
    const params = []
    if (excludeSession) {
      filters.push('m.session <> ?')
      params.push(excludeSession)
    }
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : ''
    const likeClause = keywords.map(() => 'm.body LIKE ?').join(' OR ')
    const likeParams = keywords.map((word) => `%${word}%`)
    const sql = `SELECT m.id, m.ts, m.session, m.role, m.title, m.body, 0 AS score
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
      scored.push({ row, hits })
    }
    scored.sort((a, b) => b.hits - a.hits || Number(b.row.ts) - Number(a.row.ts))
    return scored.slice(0, limit).map((item) => item.row)
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
  search(query, { limit = 5, offset = 0, excludeSession, excludeIds } = {}) {
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
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : ''
    const rows = []
    if (match) {
      const sql = `SELECT m.id, m.ts, m.session, m.role, m.title, m.body, bm25(mem_fts) AS score
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
        excludeIds: skip,
      })) {
        const id = Number(row.id)
        if (found.has(id)) continue
        found.add(id)
        rows.push(row)
      }
    }
    const out = []
    for (const row of rows) {
      const id = Number(row.id)
      if (skip.has(id)) continue
      out.push({
        id,
        ts: Number(row.ts),
        session: String(row.session ?? ''),
        role: String(row.role ?? ''),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        snippet: makeSnippet(String(row.body ?? ''), query),
        score: Number(row.score ?? 0),
      })
      if (out.length >= want) break
    }
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
        `SELECT id, ts, session, role, title, body, chars, hits FROM mem ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
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
      }))
    return { total, offset: skip, limit: take, rows }
  }

  /** 单条全文（面板点开某一项时用）。找不到返回 null。 */
  getById(id) {
    const row = this.db
      .prepare('SELECT id, ts, session, role, title, body, chars, bytes, hits, last_hit FROM mem WHERE id = ?')
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

  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }
}