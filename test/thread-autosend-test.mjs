// 自动续接：挂上旧对话文件后，第一句话应当换来一条**真实的 user/message**，
// 内容是上一个会话最后那条回答。这里用假 ctx + 假 session 验证：
//   1) 会发；2) 只发一次；3) 发出去的那条不会被再采集；4) 新建的空文件不发。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.VAULT_ROOT
  ? resolve(process.env.VAULT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = (rel) => pathToFileURL(join(ROOT, 'lib', rel)).href
const { apply } = await import(entry('index.js'))
const { MemoryStore } = await import(entry('store.js'))

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'vault-autosend-'))
const dbPath = join(dir, 'vault.db')

const handlers = new Map()
const provided = {}
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  on: (event, fn) => {
    handlers.set(event, fn)
    return () => handlers.delete(event)
  },
  get: (service) => (service === 'systemPrompt' ? { context: () => () => {} } : undefined),
  effect: () => {},
  provide: (name, value) => {
    provided[name] = value
  },
  _services: {},
}

await apply(ctx, { dbPath, maxGB: 0.05 })
const emit = (session, event) => handlers.get('session/event')?.(session, event)

const makeSession = (id) => {
  const appended = []
  return {
    id,
    header: { id, cwd: 'D:\\work' },
    appended,
    append(type, data, opts) {
      appended.push({ type, data, opts })
    },
  }
}

// ── 第一个会话：说一件事实，助手回答 ──
const s1 = makeSession('sess-1')
emit(s1, {
  type: 'user/message',
  time: 1717000000000,
  data: { role: 'user', content: [{ type: 'text', text: '我的备份脚本叫 backup-d.ps1，放在 D 盘 tools 目录，每晚两点跑' }] },
})
emit(s1, {
  type: 'assistant/message',
  time: 1717000001000,
  data: { message: { role: 'assistant', content: [{ type: 'text', text: '记住了：backup-d.ps1 在 D:\\tools，每晚 02:00 执行。' }] } },
})
await sleep(1300)

// 从库里找出这条线索，把会话 2 挂上去（等价于用户在输入框里选了那个旧文件）
const store = new MemoryStore({ dbPath, maxBytes: 200 * 1024 * 1024 })
const thread = store.listThreads({ limit: 5 })[0]
check('第一个会话自动建了对话文件', Boolean(thread?.id), JSON.stringify(store.listThreads({ limit: 5 })))
store.bindThread('sess-2', thread.id)
store.close()

// ── 第二个会话：挂上旧文件，说第一句话 ──
const s2 = makeSession('sess-2')
emit(s2, {
  type: 'user/message',
  time: 1717000010000,
  data: { role: 'user', content: [{ type: 'text', text: '接着上次的备份话题，再补一条注意事项' }] },
})
check('首次消息不立即追加（要等发布窗口结束）', s2.appended.length === 0)
await sleep(300)

check('挂上旧文件后自动发了一条消息', s2.appended.length === 1, JSON.stringify(s2.appended.map((a) => a.type)))
const sent = s2.appended[0]
check('用 user/message + surfaceOp=append', sent?.type === 'user/message' && sent?.opts?.surfaceOp === 'append', JSON.stringify(sent?.opts))
check('带非空 id 与 user 来源', typeof sent?.data?.id === 'string' && sent.data.id.length > 8 && sent.data.source?.kind === 'user', JSON.stringify(sent?.data?.source))
const sentText = sent?.data?.content?.[0]?.text ?? ''
check('正文带自动续接标记', sentText.startsWith('【对话文件·自动续接】'), sentText.slice(0, 40))
check('正文里有上一个会话的回答', sentText.includes('backup-d.ps1') && sentText.includes('每晚 02:00'), sentText.slice(0, 200))
check('正文交代了线索与文件', sentText.includes('这条线索累计'), sentText.slice(-80))

// ── 只发一次 ──
emit(s2, {
  type: 'user/message',
  time: 1717000020000,
  data: { role: 'user', content: [{ type: 'text', text: '第二个问题：这台机器的端口是多少' }] },
})
await sleep(300)
check('同一会话只自动续接一次', s2.appended.length === 1, String(s2.appended.length))
await sleep(1300) // 等第二条问题落盘，避免把它的写入算到下面的断言里

// ── 自己发出去的那条不能再被采集 ──
const before = provided.memoryVault.stats().rows
emit(s2, {
  type: 'user/message',
  time: 1717000030000,
  data: { role: 'user', content: [{ type: 'text', text: sentText }] },
})
await sleep(1300)
check('自动续接的内容不会被再次采集', provided.memoryVault.stats().rows === before, `${before} -> ${provided.memoryVault.stats().rows}`)

// ── 全新会话（自动新建的空文件）不该发任何东西 ──
const s3 = makeSession('sess-3')
emit(s3, {
  type: 'user/message',
  time: 1717000040000,
  data: { role: 'user', content: [{ type: 'text', text: '这是一段全新的对话，和之前没有关系' }] },
})
await sleep(300)
check('新文件不触发自动续接', s3.appended.length === 0, JSON.stringify(s3.appended))

// ── 关掉开关就不发 ──
const dir2 = mkdtempSync(join(tmpdir(), 'vault-autosend-off-'))
const handlers2 = new Map()
const ctx2 = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  on: (event, fn) => {
    handlers2.set(event, fn)
    return () => handlers2.delete(event)
  },
  get: (service) => (service === 'systemPrompt' ? { context: () => () => {} } : undefined),
  effect: () => {},
  provide: () => {},
  _services: {},
}
await apply(ctx2, { dbPath: join(dir2, 'vault.db'), maxGB: 0.05, threadAutoSend: false })
const emit2 = (session, event) => handlers2.get('session/event')?.(session, event)
const s4 = makeSession('sess-4')
emit2(s4, {
  type: 'user/message',
  time: 1717000050000,
  data: { role: 'user', content: [{ type: 'text', text: '第一个会话里的一句话，用来建文件' }] },
})
emit2(s4, {
  type: 'assistant/message',
  time: 1717000051000,
  data: { message: { role: 'assistant', content: [{ type: 'text', text: '这是一句回答，等会儿要被续接。' }] } },
})
await sleep(1300)
const store2 = new MemoryStore({ dbPath: join(dir2, 'vault.db'), maxBytes: 200 * 1024 * 1024 })
const thread2 = store2.listThreads({ limit: 5 })[0]
store2.bindThread('sess-5', thread2.id)
store2.close()
const s5 = makeSession('sess-5')
emit2(s5, {
  type: 'user/message',
  time: 1717000060000,
  data: { role: 'user', content: [{ type: 'text', text: '关掉开关后说一句话，不该自动发东西' }] },
})
await sleep(300)
check('threadAutoSend=false 时不追加', s5.appended.length === 0, JSON.stringify(s5.appended))

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)