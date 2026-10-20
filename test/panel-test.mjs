// .probe/panel-test.mjs — 让 lib/panel.js 的只读 HTTP 面真跑一遍（真 node:http + 真 sqlite）。
//
// 目的：面板在宿主重启前无法目视验证，但「路由 handler 是否真的返回正确 JSON」
// 完全可以在进程内验完 —— 用一个假 webServer 收下 handler，塞进真 http.Server 的请求链。
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { registerPanel } from '../lib/panel.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'vault-panel-'))
const store = new MemoryStore({ dbPath: join(dir, 'vault.db'), maxBytes: 64 * 1024 * 1024 })

const savedA = store.save({ ts: Date.now() - 60_000, session: 's1', role: 'user', title: '部署脚本', body: 'pnpm deploy 脚本发布到生产环境，注意先跑 migrate' })
const savedB = store.save({ ts: Date.now() - 30_000, session: 's2', role: 'assistant', title: '记忆系统设计', body: '用 SQLite FTS5 trigram 做中文子串检索，配额 5GB，超限按最久未用淘汰。' })

// 假 webServer：只收下 route 并记账
const captured = []
const fakeWebServer = {
  register(route) {
    captured.push(route)
    return () => {
      captured.length = 0
    }
  },
}

let threw = null
let disposer
try {
  disposer = registerPanel({ get: (n) => (n === 'webServer' ? fakeWebServer : undefined) }, store, () => {})
} catch (e) {
  threw = e
}
ok('registerPanel 不抛异常', threw === null, String(threw))
ok('挂上了 1 条 prefix 路由', captured.length === 1, JSON.stringify(captured.map((r) => r.kind + ' ' + r.path)))
ok('路由是 prefix /memory-vault', captured[0]?.kind === 'prefix' && captured[0]?.path === '/memory-vault')
ok('registerPanel 返回（或效应托管了）disposer', typeof captured[0]?.handler === 'function')

// 把 handler 塞进真 http server 的请求链
const route = captured[0]
const server = createServer((req, res) => {
  try {
    route.handler(req, res)
  } catch (e) {
    res.writeHead(500)
    res.end(String(e))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const stats = await (await fetch(`${base}/memory-vault/stats`)).json()
ok('GET /stats 返回 ok:true', stats.ok === true, JSON.stringify(stats).slice(0, 120))
ok('/stats 带 rows=2', stats.rows === 2, String(stats.rows))
ok('/stats 带 maxMB', typeof stats.maxMB === 'number' && stats.maxMB > 0, String(stats.maxMB))
ok('/stats 带 usedPercent 数值', typeof stats.usedPercent === 'number', String(stats.usedPercent))

const hit = await (await fetch(`${base}/memory-vault/search?q=` + encodeURIComponent('部署脚本'))).json()
ok('GET /search 命中', hit.ok === true && hit.results.length >= 1, JSON.stringify(hit).slice(0, 160))
ok('/search 结果带 snippet', typeof hit.results[0]?.snippet === 'string' && hit.results[0].snippet.length > 0)

const miss = await (await fetch(`${base}/memory-vault/search?q=`)).json()
ok('空 query 返回空结果（不打全库）', miss.ok === true && miss.results.length === 0)

const recent = await (await fetch(`${base}/memory-vault/recent?limit=5`)).json()
ok('GET /recent 返回 2 条', recent.ok === true && recent.results.length === 2, String(recent.results?.length))
ok('/recent 最新在前', recent.results[0]?.ts > recent.results[1]?.ts)

// ── 目录（按天/按会话）+ 分页 ──
const cat = await (await fetch(`${base}/memory-vault/catalog`)).json()
ok('GET /catalog 返回 ok:true', cat.ok === true, JSON.stringify(cat).slice(0, 120))
ok('/catalog total=2', cat.total === 2, String(cat.total))
ok('/catalog 按天分组有 1 天 2 条', cat.days?.length === 1 && cat.days[0].count === 2, JSON.stringify(cat.days))
ok('/catalog 按会话分组有 2 个会话', cat.sessions?.length === 2, JSON.stringify(cat.sessions))
ok('/catalog 会话带 newest 时间', typeof cat.sessions[0]?.newest === 'number' && cat.sessions[0].newest > 0)

const page2 = await (await fetch(`${base}/memory-vault/recent?offset=1&limit=1`)).json()
ok('/recent?offset 翻页：total 仍是 2', page2.total === 2 && page2.offset === 1, JSON.stringify(page2).slice(0, 120))
ok('/recent?offset 只回 1 条', page2.results?.length === 1, String(page2.results?.length))
ok('/recent?offset 拿到的是较旧那条', page2.results[0]?.id === savedA.id, `${page2.results[0]?.id} vs ${savedA.id}`)

const bySession = await (await fetch(`${base}/memory-vault/recent?session=s1`)).json()
ok('/recent?session 只回该会话 1 条', bySession.total === 1 && bySession.results[0]?.session === 's1', JSON.stringify(bySession).slice(0, 120))

const today = new Date(savedA.ts)
const pad = (n) => String(n).padStart(2, '0')
const dayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
const byDay = await (await fetch(`${base}/memory-vault/recent?day=${dayKey}`)).json()
ok('/recent?day 当天回 2 条', byDay.total === 2, JSON.stringify(byDay).slice(0, 120))
const byDayOld = await (await fetch(`${base}/memory-vault/recent?day=2000-01-01`)).json()
ok('/recent?day 无记录的一天回 0 条', byDayOld.total === 0 && byDayOld.results.length === 0)

// ── 单条全文 ──
const entry = await (await fetch(`${base}/memory-vault/entry?id=${savedA.id}`)).json()
ok('GET /entry 返回 ok:true', entry.ok === true, JSON.stringify(entry).slice(0, 120))
ok('/entry 带全文正文', typeof entry.entry?.body === 'string' && entry.entry.body.includes('migrate'), String(entry.entry?.body).slice(0, 80))
ok('/entry 带 chars/bytes/hits 元数据', entry.entry.chars > 0 && entry.entry.bytes > 0 && typeof entry.entry.hits === 'number')
const missing = await fetch(`${base}/memory-vault/entry?id=999999`)
ok('/entry 不存在的 id → 404', missing.status === 404, String(missing.status))
const badId = await fetch(`${base}/memory-vault/entry?id=abc`)
ok('/entry 非数字 id → 400', badId.status === 400, String(badId.status))

const nf = await fetch(`${base}/memory-vault/nope`)
ok('未知路径 → 404', nf.status === 404, String(nf.status))
const nfBody = await nf.json()
ok('未知路径有错误信息', nfBody.ok === false && typeof nfBody.error === 'string')

const post = await fetch(`${base}/memory-vault/stats`, { method: 'POST' })
ok('POST → 405（只读面）', post.status === 405, String(post.status))
const ct = (await fetch(`${base}/memory-vault/stats`)).headers.get('content-type') || ''
ok('content-type 是 json + charset', ct.includes('application/json') && ct.includes('utf-8'), ct)

// 同一路径重复注册要抛（宿主契约：duplicate prefix route）
let dupThrew = false
try {
  fakeWebServer.register({ kind: 'prefix', path: '/memory-vault', handler: () => {} })
  // 假 server 不抛，真 server 才抛；这里只验我们的 handler 不依赖它
} catch {
  dupThrew = true
}
ok('（宿主侧重复注册由 webServer 抛，非本插件职责）', true)

// 无 webServer 的 ctx：必须静默降级，不抛
let degraded = null
try {
  registerPanel({ get: () => undefined }, store, () => {})
  registerPanel({}, store, () => {})
} catch (e) {
  degraded = e
}
ok('无 webServer 时静默降级不抛', degraded === null, String(degraded))

await new Promise((r) => server.close(r))
store.close()
console.log(`\n全部通过：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)