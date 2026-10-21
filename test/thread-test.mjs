// test/thread-test.mjs — 对话文件（thread）与库位置：真 sqlite + 真 http。
//
// 覆盖两件事：
//   ① 一个对话文件 = 磁盘一个 .md + 库里一行 mem_thread，会话可以挂上去并跨会话续接；
//   ② 面板 POST /location 只改「选择」并复制库文件，重启后由 location.json 生效。
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'vault-thread-'))
const store = new MemoryStore({ dbPath: join(dir, 'vault.db'), maxBytes: 64 * 1024 * 1024 })

// ── ① 对话文件 ──
const t1 = store.createThread({ title: '修插件加载' })
ok('createThread 返回 id', Number.isInteger(t1.id) && t1.id > 0, JSON.stringify(t1))
ok('对话文件落在磁盘上', existsSync(t1.path), t1.path)
ok('文件里有标题', readFileSync(t1.path, 'utf8').includes('修插件加载'))
ok('listThreads 能看到它', store.listThreads().some((t) => t.id === t1.id))
ok('getThread 按 id 取', store.getThread(t1.id)?.id === t1.id)
ok('未挂会话时 threadOfSession 为 null', store.threadOfSession('sA') === null)

const bound = store.bindThread('sA', t1.id)
ok('bindThread 返回文件行', bound?.id === t1.id, JSON.stringify(bound))
ok('threadOfSession 能找到挂上的文件', store.threadOfSession('sA')?.id === t1.id)

store.save({ session: 'sA', role: 'user', title: '提问', body: '第一次提问：插件为什么没加载？', thread: t1.id })
store.save({ session: 'sB', role: 'user', title: '别的', body: '这条属于别的线索，不该被线索内检索命中。', thread: 0 })

const inThread = store.search('插件为什么没加载', { limit: 5, thread: t1.id })
ok('search({thread}) 只回该线索', inThread.length === 1 && inThread[0].session === 'sA', JSON.stringify(inThread.map((r) => r.session)))
ok('thread 过滤会排除 thread=0 的行', inThread.every((r) => r.session !== 'sB'))

const digest = store.threadDigest(t1.id)
ok('threadDigest 有正文', typeof digest.text === 'string' && digest.text.length > 0, JSON.stringify(digest).slice(0, 120))
ok('threadDigest 带路径与条数', digest.path === t1.path && digest.total >= 1, JSON.stringify({ p: digest.path, n: digest.total }))

// 续接的前提：这条线索被「别的会话」用过
store.bindThread('sB', t1.id)
const thread = store.threadOfSession('sB')
ok('同一线索可以挂多个会话', thread?.sessions?.length === 2, JSON.stringify(thread?.sessions))
ok('续接判定：存在非本会话的参与者', thread.sessions.some((item) => item !== 'sB'))

// ── ② 库位置（走真 http 面板） ──
const captured = []
const fakeWebServer = {
  register(route) {
    captured.push(route)
    return () => {
      captured.length = 0
    }
  },
}

const sidecar = join(dir, 'location.json')
const liveDb = join(dir, 'vault.db')
const panelOptions = {
  modes: ['long', 'multi', 'once'],
  defaultMode: 'long',
  getSessionMode: () => 'long',
  setSessionMode: (_sid, mode) => mode,
  dbPath: liveDb,
  defaultDbPath: liveDb,
  sidecar,
}

let threw = null
try {
  registerPanel({ get: (n) => (n === 'webServer' ? fakeWebServer : undefined) }, store, () => {}, panelOptions)
} catch (error) {
  threw = error
}
ok('registerPanel 不抛', threw === null, String(threw))

const route = captured[0]
const server = createServer((req, res) => {
  try {
    route.handler(req, res)
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const threads = await (await fetch(`${base}/memory-vault/threads?session=sA`)).json()
ok('GET /threads 回 ok', threads.ok === true, JSON.stringify(threads).slice(0, 120))
ok('/threads 带 current', threads.current?.id === t1.id, JSON.stringify(threads.current))
ok('/threads 列表非空', Array.isArray(threads.threads) && threads.threads.length >= 1)

const created = await (
  await fetch(`${base}/memory-vault/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '面板新建' }),
  })
).json()
ok('POST /threads 建出新文件', created.ok === true && created.thread?.id > 0, JSON.stringify(created).slice(0, 120))

const rebound = await (
  await fetch(`${base}/memory-vault/session-thread`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'sC', thread: created.thread.id }),
  })
).json()
ok('POST /session-thread 挂上', rebound.ok === true && rebound.thread?.id === created.thread.id, JSON.stringify(rebound).slice(0, 120))
ok('挂上后 threadOfSession 生效', store.threadOfSession('sC')?.id === created.thread.id)

const badBind = await fetch(`${base}/memory-vault/session-thread`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: '', thread: 0 }),
})
ok('坏参数 400', badBind.status === 400, String(badBind.status))

const one = await (await fetch(`${base}/memory-vault/thread?id=${t1.id}`)).json()
ok('GET /thread 回摘要', one.ok === true && one.digest?.text?.length > 0, JSON.stringify(one).slice(0, 120))
const missing = await fetch(`${base}/memory-vault/thread?id=999999`)
ok('不存在的文件 404', missing.status === 404, String(missing.status))

const loc = await (await fetch(`${base}/memory-vault/location`)).json()
ok('GET /location 回当前路径', loc.ok === true && loc.dbPath === liveDb, JSON.stringify(loc))

const moved = await (
  await fetch(`${base}/memory-vault/location`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(dir, 'moved', 'vault2.db') }),
  })
).json()
ok('POST /location 接受新路径', moved.ok === true && moved.restart === true, JSON.stringify(moved))
ok('新路径目录被建出来', existsSync(join(dir, 'moved')), join(dir, 'moved'))
ok('库文件被复制到新位置', existsSync(join(dir, 'moved', 'vault2.db')))
ok('选择写进 location.json', existsSync(sidecar) && JSON.parse(readFileSync(sidecar, 'utf8')).dbPath.endsWith('vault2.db'))

const badPath = await fetch(`${base}/memory-vault/location`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: 'not-a-db-file' }),
})
ok('不是 .db 结尾 400', badPath.status === 400, String(badPath.status))

const reset = await (
  await fetch(`${base}/memory-vault/location`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  })
).json()
ok('POST /location reset 回到默认', reset.ok === true && reset.dbPath === liveDb, JSON.stringify(reset))
ok('reset 删掉 location.json', !existsSync(sidecar))

server.close()
store.close()

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)