// store.js 自测：真 node:sqlite + FTS5 trigram，不依赖 DSH
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, buildMatchQuery, makeSnippet, normalizeBody, pickDigest, isValidMode, MEMORY_MODES } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'vault-test-'))
const dbPath = join(dir, 'vault.db')
const store = new MemoryStore({ dbPath, maxBytes: 64 * 1024 })

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label} ${detail}`)
  }
}

console.log(`db: ${dbPath}\n`)

// --- 归一化 ---
check('normalize 折叠空行', normalizeBody('a\n\n\n\nb') === 'a\n\nb', JSON.stringify(normalizeBody('a\n\n\n\nb')))
check('normalize CRLF', normalizeBody('a\r\nb') === 'a\nb')
check('normalize 截断', normalizeBody('x'.repeat(50), 10).startsWith('x'.repeat(10) + '\n…'))

// --- 查询词构造 ---
const mq = buildMatchQuery('你上次说的那个部署脚本叫什么名字来着')
check('match: 中文切窗非空', mq.length > 0, mq)
check('match: 拉丁词保留', buildMatchQuery('deploy.sh 怎么跑').includes('"deploy.sh"'.slice(1, -1)) || buildMatchQuery('deploy.sh 怎么跑').includes('deploy'))
check('match: 空查询为空串', buildMatchQuery('').length === 0)
check('match: 单字查询为空串', buildMatchQuery('好').length === 0)
console.log(`  · 样例 MATCH = ${mq}\n`)

// --- snippet ---
const long = '前言'.repeat(50) + '目标关键词' + '后记'.repeat(200)
const snip = makeSnippet(long, '目标关键词', 40)
check('snippet 命中词附近开窗', snip.includes('目标关键词'), snip)
check('snippet 短文本原样', makeSnippet('短', 'x', 40) === '短')

// --- 写入 / 去重 ---
const a = store.save({ ts: 1000, session: 's1', role: 'user', title: '部署', body: '我们用 pnpm deploy 脚本发布到杭州的服务器' })
check('save 首次 created', a.created === true && a.id === 1)
const a2 = store.save({ ts: 2000, session: 's2', role: 'user', title: '部署', body: '我们用 pnpm deploy 脚本发布到杭州的服务器' })
check('save 重复内容不新增，只嫌 hit', a2.created === false && a2.id === a.id)
check('重复后行数仍为 1', store.stats().rows === 1)

store.save({ ts: 3000, session: 's1', role: 'assistant', title: '记忆', body: '长期记忆系统建议用 SQLite 的 FTS5 trigram 索引，中文不用外部分词' })
store.save({ ts: 4000, session: 's2', role: 'user', title: '记忆', body: '上下文窗口只有 12 万 token，5GB 磁盘记忆得靠按需检索注入' })
store.save({ ts: 5000, session: 's3', role: 'user', title: '无关', body: '今天下午三点开会讨论前端样式' })
check('5 条入座', store.stats().rows === 4, String(store.stats().rows))

// --- 检索 ---
const r1 = store.search('记忆系统')
check('FTS 中文命中', r1.length >= 1, JSON.stringify(r1.map((r) => r.title)))
check('FTS 命中正确条', r1.some((r) => r.body.includes('FTS5 trigram')))
const r2 = store.search('部署脚本')
check('FTS 第二组命中', r2.some((r) => r.body.includes('pnpm deploy')), JSON.stringify(r2.map((r) => r.body.slice(0, 12))))
const r3 = store.search('token')
check('拉丁词命中', r3.some((r) => r.body.includes('12 万 token')))
const r4 = store.search('记忆系统', { excludeSession: 's1' })
check('excludeSession 生效', r4.every((r) => r.session !== 's1'), JSON.stringify(r4.map((r) => r.session)))
const r5 = store.search('记忆系统', { excludeIds: new Set([r1[0]?.id]) })
check('excludeIds 生效', r5.every((r) => r.id !== r1[0]?.id))
const r6 = store.search('完全不存在的词汇组合')
check('无命中返回空数组', Array.isArray(r6) && r6.length === 0)
const r7 = store.search('开会')  // 2 字 → trigram 不可用 → LIKE 兜底
check('短中文 LIKE 兜底', r7.some((r) => r.body.includes('三点开会')), JSON.stringify(r7.length))
const r8 = store.search('记忆系统', { limit: 1 })
check('limit 生效', r8.length === 1)

// --- 热度 / 最近 ---
store.markUsed([a.id], 9000)
const recent = store.recent(10)
check('recent 按时间倒序', recent[0].ts === 5000, String(recent[0]?.ts))
check('markUsed 生效', recent.find((r) => r.id === a.id)?.hits >= 1)

// --- 删除 ---
check('deleteById 成功', store.deleteById(a.id) === true)
check('deleteById 后不可检索', store.search('pnpm deploy 脚本').every((r) => r.id !== a.id))
check('deleteById 不存在返回 false', store.deleteById(99999) === false)

// --- 配额（maxBytes=64KB，持续写入小额记忆直到越限）---
const before = store.stats()
// 每条约 1000 字节，写 120 条 ≈ 120KB，越过 64KB 上限
for (let i = 0; i < 120; i++) {
  store.save({
    ts: 10000 + i,
    session: 'bulk',
    role: 'user',
    title: `填充-${i}`,
    body: `第 ${i} 条填充。${'这是一段用于撑大体积的中文内容。'.repeat(25)}`,
  })
}
const afterSave = store.stats()
check('写入后确已越限', afterSave.bytes > 64 * 1024, `${afterSave.bytes}/${64 * 1024}`)
const removed = store.enforceQuota()
const afterQuota = store.stats()
check('超配额触发淘汰', removed > 0, `removed=${removed}`)
check('淘汰后回落至水位以下', afterQuota.bytes <= 64 * 1024, `${afterQuota.bytes}/${64 * 1024}`)
check('淘汰保留最新（ts 最大）条目', store.search('填充').some((r) => r.title === '填充-119'), JSON.stringify(store.search('填充').map((r) => r.title).slice(0, 3)))
check('淘汰从最旧的开始删', !store.search('填充').some((r) => r.title === '填充-0'))
check('至少保留一条', afterQuota.rows >= 1, String(afterQuota.rows))
console.log(`  · 写入前 ${before.rows} 行/${before.bytes}B → 写入后 ${afterSave.rows} 行/${afterSave.bytes}B → 淘汰 ${removed} 条 → ${afterQuota.rows} 行/${afterQuota.bytes}B`)
// 单条上限必须远小于配额（否则一条巨型记忆能把整库挤空）
check('单条上限被配额约束', store.maxBodyChars <= Math.floor(64 * 1024 / 20 / 3), String(store.maxBodyChars))

// --- 统计字段完整性 ---
const st = store.stats()
check('stats 字段齐备', ['dbPath', 'rows', 'bytes', 'usedMB', 'maxMB', 'usedPercent', 'byRole', 'oldest', 'newest'].every((k) => k in st), JSON.stringify(st))

// --- 会话摘要（压缩层）：抽取式、不调模型 ---
{
  const dir2 = mkdtempSync(join(tmpdir(), 'vault-digest-'))
  const s = new MemoryStore({ dbPath: join(dir2, 'vault.db'), maxBytes: 5 * 1024 ** 3 })
  s.save({ ts: 1000, session: 'sess-A', role: 'user', title: 't', body: '我们决定把部署脚本改成 pnpm deploy:prod，先跑数据库迁移再发布到生产环境。' })
  s.save({ ts: 1100, session: 'sess-A', role: 'assistant', title: 't', body: '好的，迁移命令是 pnpm migrate，注意先备份数据库。' })
  s.save({ ts: 2000, session: 'sess-B', role: 'user', title: 't', body: '记忆库的配额上限改成 20GB 吧，常用档位里正好有这一档。' })
  const digests = s.sessionDigests({ limit: 5 })
  check('sessionDigests 覆盖两个会话', digests.length === 2, String(digests.length))
  check('会话摘要按最近时间排序', digests[0].session === 'sess-B', digests[0].session)
  check('每个会话都有摘要', digests.every((d) => d.digest.length > 0), JSON.stringify(digests.map((d) => d.digest.length)))
  check('摘要抓住关键事实', digests.some((d) => /pnpm deploy:prod|pnpm migrate/.test(d.digest)), JSON.stringify(digests.map((d) => d.digest)))
  check('摘要长度受控', digests.every((d) => d.digest.length <= 270), JSON.stringify(digests.map((d) => d.digest.length)))
  check('count 与库内条数一致', digests.find((d) => d.session === 'sess-A')?.count === 2, JSON.stringify(digests.map((d) => d.count)))
  check('excludeSession 生效', s.sessionDigests({ excludeSession: 'sess-B' }).every((d) => d.session !== 'sess-B'))
  check('没有实词的短句不出摘要', pickDigest([{ role: 'user', body: '这个那个就是' }], {}) === '')
  const tight = s.sessionDigests({ limit: 5, perSessionChars: 40 })
  check('perSessionChars 生效', tight.every((d) => d.digest.length <= 41), JSON.stringify(tight.map((d) => d.digest.length)))
  s.close()
}

store.close()

// --- 老库升级：没有 mode 列的库要能直接打开（真实踩过的坑）---
{
  const legacyPath = join(dir, 'legacy.db')
  // 用 0.6.x 的建表语句造一个「没有 mode 列」的库，并塞一条历史记忆
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`
    CREATE TABLE mem (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, hash TEXT NOT NULL,
      chars INTEGER NOT NULL, bytes INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
      last_hit INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX mem_hash ON mem(hash);
  `)
  legacy.prepare('INSERT INTO mem (ts, session, role, title, body, hash, chars, bytes) VALUES (?,?,?,?,?,?,?,?)')
    .run(Date.now(), 'old', 'user', '老记忆', '老库里的一条记忆：用 pnpm 部署', 'h1', 20, 40)
  legacy.close()

  let upgraded = null
  let upgradeError = ''
  try {
    upgraded = new MemoryStore({ dbPath: legacyPath })
  } catch (error) {
    upgradeError = error?.message ?? String(error)
  }
  check('老库（无 mode 列）能打开，不再抛 no such column', upgraded !== null, upgradeError)
  if (upgraded) {
    check('老库数据仍在', upgraded.stats().rows === 1, String(upgraded.stats().rows))
    check('老记忆默认算长期', upgraded.stats().byMode.long === 1, JSON.stringify(upgraded.stats().byMode))
    check('老库升级后还能检索', upgraded.search('pnpm 部署').length === 1)
    upgraded.close()
  }
}

// --- 记忆模式：长期 / 本会话多次 / 单次 ---
{
  check('模式取值只有三种', MEMORY_MODES.join(',') === 'long,multi,once', MEMORY_MODES.join(','))
  check('isValidMode 认 long', isValidMode('long'))
  check('isValidMode 拒 unknown', !isValidMode('forever'))
  const s = new MemoryStore({ dbPath: join(dir, 'mode.db') })
  check('默认写入是长期', s.save({ session: 'A', role: 'user', body: '长期记忆：每周五发版' }).mode === 'long')
  check('multi 能写进去', s.save({ session: 'A', role: 'user', body: '本会话才用的临时口径', mode: 'multi' }).mode === 'multi')
  check('once 能写进去', s.save({ session: 'A', role: 'user', body: '一次性口令：只在这次说', mode: 'once' }).mode === 'once')
  check('非法 mode 回落长期', s.save({ session: 'A', role: 'user', body: '乱传模式也该安全', mode: 'nope' }).mode === 'long')
  const byMode = s.stats().byMode
  check('统计里有模式分布', byMode.long === 2 && byMode.multi === 1 && byMode.once === 1, JSON.stringify(byMode))

  // multi 只在自己会话可见
  const inA = s.search('临时口径', { scopeSession: 'A' })
  const inB = s.search('临时口径', { scopeSession: 'B' })
  check('multi 在自己会话可见', inA.some((r) => r.body.includes('临时口径')), JSON.stringify(inA.map((r) => r.id)))
  check('multi 在别的会话不可见', !inB.some((r) => r.body.includes('临时口径')), JSON.stringify(inB.map((r) => r.id)))
  const longInB = s.search('每周五发版', { scopeSession: 'B' })
  check('long 跨会话仍可见', longInB.some((r) => r.body.includes('每周五发版')))

  // once 消费即删
  const onceRow = s.search('一次性口令', { scopeSession: 'A' })[0]
  check('once 能搜到', Boolean(onceRow))
  const removed = s.consumeOnce([onceRow.id])
  check('consumeOnce 删掉 1 条', removed === 1, String(removed))
  check('once 删完搜不到', s.search('一次性口令', { scopeSession: 'A' }).length === 0)
  check('consumeOnce 不误删 long', s.consumeOnce([1]) === 0)

  // 过期清理
  const oldTs = Date.now() - 13 * 60 * 60 * 1000
  s.save({ ts: oldTs, session: 'A', role: 'user', body: '13 小时前的临时记忆', mode: 'multi' })
  const purged = s.purgeTransient()
  check('过期 multi 被清掉', purged.multi === 1, JSON.stringify(purged))
  check('长期记忆不受影响', s.stats().byMode.long === 2, JSON.stringify(s.stats().byMode))
  s.close()
}

// --- 重开持久化 ---
const store2 = new MemoryStore({ dbPath, maxBytes: 5 * 1024 ** 3 })
check('重开后数据仍在', store2.stats().rows > 0, String(store2.stats().rows))
store2.close()

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)