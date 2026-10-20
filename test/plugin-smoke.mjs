// 插件入口自测：用假 ctx 走一遍「采集 → 落盘 → 召回 → 回灌防护 → 关停」。
// 不依赖 dsh 宿主；真实 defineTool 拿不到时插件应当自动降级而不是抛错（这正是要验的）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 默认测工作区源码（相对本脚本定位）；设 VAULT_ROOT 可指向**已安装的 generation 副本**，
// 用来确认「装进去的那份」也能跑（防止 files 白名单漏文件）。
const ROOT = process.env.VAULT_ROOT
  ? resolve(process.env.VAULT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = (rel) => pathToFileURL(join(ROOT, 'lib', rel)).href
const { apply, resolveConfig, Config } = await import(entry('index.js'))
console.log(`(被测入口：${ROOT})`)

const dir = mkdtempSync(join(tmpdir(), 'vault-plugin-'))
const dbPath = join(dir, 'vault.db')

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

// ── Config 校验 ──
check('Config 暴露 standard-schema 接口', typeof Config['~standard']?.validate === 'function')
const good = resolveConfig({ maxGB: 5 })
check('默认值补齐', good.maxGB === 5 && good.enabled === true && good.recallLimit === 5)
check('默认 dbPath 在 D 盘', good.dbPath.startsWith('D:\\'), good.dbPath)
let threw = ''
try { resolveConfig({ maxGB: 'abc' }) } catch (e) { threw = e.message }
check('非法数字加载期响亮失败', threw.includes('maxGB'), threw)
threw = ''
try { resolveConfig({ enabled: 'yes' }) } catch (e) { threw = e.message }
check('非法布尔加载期响亮失败', threw.includes('enabled'), threw)
check('未声明的键被忽略而非报错', resolveConfig({ unknownKey: 1 }).enabled === true)

// ── 假 ctx ──
const handlers = new Map()
const disposers = []
let recallProvider = null
const provided = {}
const logs = []
const ctx = {
  logger: () => ({ info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) }),
  on: (event, fn) => {
    handlers.set(event, fn)
    return () => handlers.delete(event)
  },
  get: (service) => {
    if (service === 'systemPrompt') {
      return { context: (def) => { recallProvider = def; return () => { recallProvider = null } } }
    }
    return undefined // tools 不可得 → 走降级路径
  },
  effect: (fn) => { disposers.push(fn()) },
  provide: (name, value) => { provided[name] = value },
  _services: {},
}

await apply(ctx, { dbPath, maxGB: 0.05 })

check('订阅了 session/event', handlers.has('session/event'))
check('挂载了召回 provider', recallProvider !== null)
check('provider 名字与 order', recallProvider?.name === 'memory:recall' && recallProvider?.order === 130, JSON.stringify(recallProvider?.name))
check('注册了生命周期 disposer', disposers.length === 1)
check('暴露了 memoryVault 探查口', typeof provided.memoryVault?.stats === 'function')
check('无 defineTool 时降级不抛错', logs.some(([lvl, m]) => lvl === 'warn' && m.includes('defineTool')), JSON.stringify(logs.map((l) => l[1])))

// ── 采集：会话 A 说了一件事实 ──
const emit = (session, event) => handlers.get('session/event')?.(session, event)
const sessionA = { id: 'sess-A', header: { id: 'sess-A', cwd: 'D:\\work' } }
const sessionB = { id: 'sess-B', header: { id: 'sess-B', cwd: 'D:\\work' } }

emit(sessionA, {
  type: 'user/message',
  time: 1717000000000,
  data: { role: 'user', content: [{ type: 'text', text: '我们的部署流程是先用 pnpm build 再用 scp 推到杭州的 10.0.0.7 服务器' }] },
})
emit(sessionA, {
  type: 'assistant/message',
  time: 1717000001000,
  data: { message: { role: 'assistant', content: [{ type: 'text', text: '记下了：pnpm build 之后 scp 到 10.0.0.7，这是杭州集群的入口机。' }] } },
})
await sleep(1300) // 等 1s 批量 flush

const stats1 = provided.memoryVault.stats()
check('两条消息已入库', stats1.rows === 2, JSON.stringify(stats1.byRole))
check('用户与助手分别记账', stats1.byRole.user === 1 && stats1.byRole.assistant === 1, JSON.stringify(stats1.byRole))

// ── 不该入库的：thinking 块、工具结果、子代理会话、我们自己注入的召回块 ──
emit(sessionA, {
  type: 'user/message',
  time: 1717000002000,
  data: { role: 'user', content: [{ type: 'thinking', thinking: '这句是思考块，不该被记' }] },
})
emit(sessionA, {
  type: 'user/message',
  time: 1717000003000,
  data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }] },
})
emit({ id: 'sess-SUB', header: { id: 'sess-SUB', origin: 'subagent', delegationDepth: 1 } }, {
  type: 'user/message',
  time: 1717000004000,
  data: { role: 'user', content: [{ type: 'text', text: '子代理的中间过程不该成为记忆' }] },
})
emit(sessionB, {
  type: 'user/message',
  time: 1717000005000,
  data: { role: 'user', content: [{ type: 'text', text: '【长期记忆·自动召回】这是上一轮注入的召回块，不能被当成用户的话再记一遍' }] },
})
await sleep(1300)
check('噪声消息全部被过滤', provided.memoryVault.stats().rows === 2, JSON.stringify(provided.memoryVault.stats().byRole))

// ── 召回：会话 B 提到相关词，应召回会话 A 的内容 ──
emit(sessionB, {
  type: 'user/message',
  time: 1717000010000,
  data: { role: 'user', content: [{ type: 'text', text: '杭州那台机器上部署要注意什么来着？上次说的部署脚本命令是什么' }] },
})
await sleep(1200)
const injected = recallProvider.text({ agent: { session: sessionB } })
check('召回返回了文本', typeof injected === 'string' && injected.length > 0, injected?.slice(0, 60))
check('召回内容包含历史事实', injected.includes('10.0.0.7') || injected.includes('pnpm build'), injected?.slice(0, 200))
check('召回带防误用措辞', injected.includes('以当前指令为准'))
check('召回排除了当前会话刚说过的话', !injected.includes('部署要注意什么来着'), injected?.slice(0, 200))

// 同一会话重复 assemble 不应重复注入同一条
const second = recallProvider.text({ agent: { session: sessionB } })
check('同一会话不重复注入', second === '' || !second.includes('10.0.0.7'), JSON.stringify(second?.slice(0, 80)))

// 子代理会话不召回
const subInjected = recallProvider.text({ agent: { session: { id: 'sess-SUB', header: { origin: 'subagent', delegationDepth: 1 } } } })
check('子代理会话不触发召回', subInjected === '', JSON.stringify(subInjected))

// 短输入不检索
emit(sessionB, { type: 'user/message', time: 1717000020000, data: { role: 'user', content: [{ type: 'text', text: '嗯' }] } })
await sleep(1200)
check('短输入不触发检索', recallProvider.text({ agent: { session: sessionB } }) === '')
check('过短消息不入库（captureMinChars）', provided.memoryVault.stats().rows === 3, JSON.stringify(provided.memoryVault.stats().byRole))

// ── 同会话更早记忆的开关：窗口=0 时，本会话自己的内容也在召回范围内 ──
{
  const dir2 = mkdtempSync(join(tmpdir(), 'vault-same-'))
  const handlers2 = new Map()
  let provider2 = null
  const ctx2 = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    on: (e, fn) => { handlers2.set(e, fn); return () => handlers2.delete(e) },
    get: (s) => (s === 'systemPrompt' ? { context: (def) => { provider2 = def; return () => { provider2 = null } } } : undefined),
    effect: () => {},
    provide: () => {},
  }
  await apply(ctx2, { dbPath: join(dir2, 'vault.db'), maxGB: 0.05, recallRecentWindow: 0 })
  const sessionC = { id: 'sess-C', header: { id: 'sess-C' } }
  handlers2.get('session/event')?.(sessionC, {
    type: 'user/message',
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text: '生产环境的部署脚本是 pnpm deploy:prod，记得先跑 migrate' }] },
  })
  await sleep(1300)
  const ownText = provider2?.text({ agent: { session: sessionC } }) ?? ''
  check('recallRecentWindow=0 时同会话记忆可召回', ownText.includes('pnpm deploy:prod'), JSON.stringify(ownText.slice(0, 120)))
  // 召回不只是摘要：带 id 指针 + 尾注告诉模型怎么继续取（窗口不变、可达范围变大靠这一环）
  check('召回每条带 id 指针', /id=\d+/.test(ownText), JSON.stringify(ownText.slice(0, 80)))
  check('召回尾注指向 memory_open', ownText.includes('memory_open') && ownText.includes('memory_search'), JSON.stringify(ownText.slice(-120)))
}

// ── 按需分页：memory_open 的 store 侧行为 + search 的 offset 翻页 ──
{
  const store = provided.memoryVault.store
  const body = '开头标记HEAD ' + '甲'.repeat(1200) + '中间标记MID ' + '乙'.repeat(1800) + '结尾标记TAIL'
  const saved = store.save({ ts: Date.now(), session: 'paging', role: 'user', title: '长文分页', body })
  const p1 = store.open(saved.id, { chars: 1000 })
  check('memory_open 首段长度与起点', p1 && p1.offset === 0 && p1.body.length === 1000, JSON.stringify({ len: p1?.body.length, off: p1?.offset }))
  check('memory_open 给出 next', p1.next === 1000, String(p1.next))
  check('memory_open 报告总字数', p1.total === body.length, `${p1.total} vs ${body.length}`)
  const p2 = store.open(saved.id, { offset: p1.next, chars: 1000 })
  check('续读从 next 接着且内容不同', p2.offset === 1000 && p2.body !== p1.body, JSON.stringify({ off: p2?.offset }))
  const tail = store.open(saved.id, { offset: p2.next, chars: 12000 })
  check('读到末尾 next 为 null', tail.next === null && tail.end === tail.total, JSON.stringify({ next: tail?.next, end: tail?.end, total: tail?.total }))
  check('末尾那段确实含结尾标记', tail.body.includes('结尾标记TAIL'))
  check('越界 offset 夹到末尾而非报错', store.open(saved.id, { offset: 9e9 }).body === '')
  check('不存在的 id 返回 null', store.open(987654) === null)
  store.save({ ts: Date.now() + 1, session: 'paging', role: 'user', title: '翻页甲', body: '翻页关键词 alpha 一号记录' })
  store.save({ ts: Date.now() + 2, session: 'paging', role: 'user', title: '翻页乙', body: '翻页关键词 alpha 二号记录' })
  const s0 = store.search('翻页关键词', { limit: 1, offset: 0 })
  const s1 = store.search('翻页关键词', { limit: 1, offset: 1 })
  check(
    'search 的 offset 翻到不同条目',
    s0.length === 1 && s1.length === 1 && s0[0].id !== s1[0].id,
    `${s0[0]?.id} vs ${s1[0]?.id}`,
  )
  check('offset 越过命中总数时返回空', store.search('翻页关键词', { limit: 5, offset: 50 }).length === 0)
}

// ── 关停 ──
const beforeClose = provided.memoryVault.stats().rows
disposers[0]()
emit(sessionA, { type: 'user/message', time: 1717000030000, data: { role: 'user', content: [{ type: 'text', text: '关停之后的话不该入库，因为插件已经停了' }] } })
await sleep(1300)
check('关停后 assemble 返回空', recallProvider === null || recallProvider.text({ agent: { session: sessionB } }) === '')

// 关停时应强制 flush 且关库；重开验证落盘一致、没有多写
const { MemoryStore } = await import(entry('store.js'))
const reopened = new MemoryStore({ dbPath })
check('关停后重开：数据完整持久', reopened.stats().rows === beforeClose, `${reopened.stats().rows} vs ${beforeClose}`)
const persisted = reopened.search('部署流程')
check('关停后重开：内容仍可检索', persisted.length > 0 && persisted[0].body.includes('10.0.0.7'))
reopened.close()

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
console.log(`db: ${dbPath}`)
process.exit(fail === 0 ? 0 : 1)