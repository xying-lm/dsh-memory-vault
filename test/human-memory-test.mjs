// 「像人一样记忆」的三个因子 + 巩固层自测：真 node:sqlite，不依赖 DSH
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, salienceOf, decayFactor } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'vault-human-'))
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

const DAY = 86400000
const now = Date.now()

// ── 显著性 ──
const casual = salienceOf('好的，我看一下', 'assistant')
const decision = salienceOf('记住：以后部署一律用 deploy-prod.ps1，别再手动复制了，路径放 D:\\tools', 'user')
const logDump = salienceOf('x'.repeat(4000), 'assistant')
check('显著性：闲聊低', casual < 0.35, String(casual))
check('显著性：决策高', decision > 0.6, String(decision))
check('显著性：决策 > 闲聊', decision > casual)
check('显著性：超长日志不算重要', logDump <= 0.3, String(logDump))
check('显著性：落在 0~1', [casual, decision, logDump, salienceOf('', 'user')].every((v) => v >= 0 && v <= 1))

// ── 遗忘曲线 ──
const fresh = decayFactor({ ts: now, salience: 0.2, now })
const oldLow = decayFactor({ ts: now - 400 * DAY, salience: 0.2, now })
const oldHigh = decayFactor({ ts: now - 400 * DAY, salience: 0.9, now })
check('衰减：新鲜≈1', fresh > 0.95, String(fresh))
check('衰减：长期低显著 < 新鲜', oldLow < fresh, `${oldLow} < ${fresh}`)
check('衰减：同样老，高显著的衰减更慢', oldHigh > oldLow, `${oldHigh} > ${oldLow}`)
check('衰减：下限 0.45（只降权不删除）', oldLow >= 0.45, String(oldLow))

// ── 三因子检索排序 ──
store.save({
  ts: now - 180 * DAY,
  session: 's-old',
  role: 'user',
  body: '记住这条约定：数据库备份一律用 pg_dump，别再手动拷贝文件了，上次就是这样出的故障。',
})
store.save({
  ts: now,
  session: 's-new',
  role: 'assistant',
  body: '数据库备份这个词今天又出现了，我顺口提一句而已，没有别的意思。',
})
const ranked = store.search('数据库备份怎么做', { limit: 2 })
check('排序：显著性高的旧记忆排到前面', ranked[0]?.session === 's-old', ranked.map((r) => r.session).join(','))
const legacy = store.search('数据库备份怎么做', { limit: 2, human: false })
check('排序：关掉 human 就回到字面名次', legacy[0]?.session === 's-new', legacy.map((r) => r.session).join(','))

// ── 联想边 ──
const a = store.save({ ts: now - 3 * DAY, session: 's-link', role: 'user', body: '部署脚本 deploy-prod.ps1 在 D 盘 tools 目录，路径别改。' })
const b = store.save({ ts: now - 2 * DAY, session: 's-link', role: 'assistant', body: 'deploy-prod.ps1 那个部署脚本我记下了，D 盘 tools 路径也记下了。' })
check('联想：同会话近邻共享关键词会建边', a.created && b.created)
const hits = store.search('deploy-prod.ps1 在哪', { limit: 1 })
const expanded = store.withAssociations(hits, { limit: 1 })
check('联想：命中一条时能扩出邻居', expanded.length >= 2, `len=${expanded.length}`)
check('联想：扩展项带 kind=assoc', expanded.slice(1).every((item) => item.kind === 'assoc'))
check('联想：扩展项不与主结果重复', new Set(expanded.map((item) => item.id)).size === expanded.length)
check('联想：limit=0 时不扩展', store.withAssociations(hits, { limit: 0 }).length === hits.length)

// ── 巩固层：跨会话的反复内容抽成事实卡 ──
for (const [session, ts] of [['s-a', now - 9 * DAY], ['s-b', now - 8 * DAY], ['s-c', now - 7 * DAY]]) {
  store.save({
    ts,
    session,
    role: 'user',
    body: `再确认一次（${session}）：这个项目的部署脚本统一叫 deploy-prod.ps1，放在 D 盘 tools 目录，别再用旧的 deploy.ps1 了。`,
  })
}
const consolidated = store.consolidate()
check('巩固：生成了事实卡', consolidated.cards >= 1, JSON.stringify(consolidated))
check('巩固：stats 里能看到事实卡张数', Number(store.stats().facts) >= 1, String(store.stats().facts))
const facts = store.searchFacts('部署脚本叫什么', { limit: 2 })
check('巩固：按关键词能搜到事实卡', facts.length >= 1, `len=${facts.length}`)
check('巩固：事实卡 kind=fact 且 id 指向原文', facts[0] && facts[0].kind === 'fact' && facts[0].id > 0)
const opened = facts[0] ? store.open(facts[0].id, { chars: 200 }) : null
check('巩固：事实卡的 id 能 memory_open 读到原文', Boolean(opened?.body))

// ── 老库回填：kw/salience 为空时自动补 ──
const legacyRow = store.save({ ts: now - DAY, session: 's-legacy', role: 'user', body: '这是一条没有关键词签名的老记忆，用来测回填。' })
store.db.prepare("UPDATE mem SET kw = '', salience = 0 WHERE id = ?").run(legacyRow.id)
store.db.prepare("DELETE FROM mem_meta WHERE key = 'human_v1'").run()
const filled = store.rebuildHumanIndex()
const after = store.db.prepare('SELECT kw, salience FROM mem WHERE id = ?').get(legacyRow.id)
check('回填：老行补上了关键词签名', filled > 0 && String(after?.kw ?? '').length > 0, JSON.stringify(after))
check('回填：老行补上了显著性', Number(after?.salience ?? 0) > 0, JSON.stringify(after))

// ── multi 模式不越界 ──
const multi = store.save({ ts: now - DAY, session: 's-private', role: 'user', body: 'deploy-prod.ps1 这个脚本只在当前会话有效，别的会话不该看到。', mode: 'multi' })
const crossHits = store.search('deploy-prod.ps1 在哪', { limit: 5, scopeSession: 's-other' })
check('多模式：别的会话检索不到 multi', !crossHits.some((item) => item.id === multi.id))
const sameHits = store.search('deploy-prod.ps1 在哪', { limit: 5, scopeSession: 's-private' })
check('多模式：本会话检索得到 multi', sameHits.some((item) => item.id === multi.id))

// ── 去重不吃掉「跨会话反复出现」这个信号 ──
const first = store.save({ ts: now - 6 * DAY, session: 's-dedupe', role: 'user', body: '同一条内容在两个会话里被复述：部署脚本用 deploy-prod.ps1。' })
const second = store.save({ ts: now - 5 * DAY, session: 's-dedupe-2', role: 'user', body: '同一条内容在两个会话里被复述：部署脚本用 deploy-prod.ps1。' })
const seenSessions = String(store.db.prepare('SELECT sessions FROM mem WHERE id = ?').get(first.id)?.sessions ?? '')
check('去重：同样内容只存一行', first.created && !second.created && first.id === second.id)
check('去重：会话列表记下了两个会话', seenSessions.includes('s-dedupe') && seenSessions.includes('s-dedupe-2'), seenSessions)

store.close()
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)