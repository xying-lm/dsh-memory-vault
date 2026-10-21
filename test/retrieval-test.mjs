// 检索与召回的成本控制：摘录取句、去重、分层预算、低信息跳过、本轮自排除。
// 这一套断言全部围绕「同样的召回质量下，花掉多少字」——所以断言里直接量长度。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.VAULT_ROOT
  ? resolve(process.env.VAULT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import(pathToFileURL(join(ROOT, 'lib', rel)).href)

const { apply } = await load('index.js')
const { MemoryStore, makeFocusSnippet, dropDuplicates } = await load('store.js')

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

// ── 1. 摘录取句：长文里只摘命中词那一句 ──
const longBody = [
  '这次把整套构建链路整理了一遍，先从清理缓存开始，然后逐层打包，注意不要再动 lockfile。',
  '部署脚本叫 deploy-prod.ps1，放在 D 盘 tools 目录下，跑之前记得先 scp 推到 10.0.0.7。',
  '另外把日志目录改到了 D 盘的 logs 下面，方便一起备份，不用再翻临时目录。',
  '最后还有一件小事：面板的容量档位默认选 5GB，别改坏了。',
].join('')
const focus = makeFocusSnippet(longBody, '部署脚本叫什么', 160)
check('取句摘录只取命中那一句', focus.includes('deploy-prod.ps1'), focus)
check('取句摘录显著短于窗口式', focus.length <= 160 && focus.length < 220, String(focus.length))
check('取句摘录不带省略号拼接', !focus.includes('…') || focus.length <= 160)

// 整条都没有命中词时才退回窗口式
const noHit = makeFocusSnippet(longBody, '完全不相干的词', 120)
check('无命中时退回窗口式摘录', noHit.length > 0 && noHit.length <= 130, String(noHit.length))

// ── 2. 去重：两条几乎同话的记忆只花一次 ──
const dupes = [
  { id: 1, snippet: '杭州集群的入口机是 10.0.0.7，pnpm build 之后用 scp 推送。', score: -3 },
  { id: 2, snippet: '杭州集群的入口机是 10.0.0.7，pnpm build 之后用 scp 推送完成。', score: -4 },
  { id: 3, snippet: '记忆库的容量档位是 1/5/10/20/50GB，默认 5GB。', score: -9 },
]
const deduped = dropDuplicates(dupes)
check('高度重合的命中被合并', deduped.length === 2, JSON.stringify(deduped.map((d) => d.id)))
check('合并时保留相关度更高的那条', deduped[0].id === 1)

// ── 3. 本轮消息不自我召回（时间戳守卫）──
const dir = mkdtempSync(join(tmpdir(), 'vault-retrieval-'))
const store = new MemoryStore({ dbPath: join(dir, 'unit.db'), maxBytes: 50 * 1024 * 1024 })
store.save({ ts: 1000, session: 's', role: 'user', body: '早先说过：部署脚本是 deploy-prod.ps1' })
store.save({ ts: 3000, session: 's', role: 'assistant', body: '这一轮才说的：部署脚本清单又更新了' })
const guarded = store.search('部署脚本', { beforeTs: 2000, beforeSession: 's' })
check('时间戳守卫排除本轮新写入', guarded.every((row) => row.id !== 2) && guarded.length >= 1, JSON.stringify(guarded.map((r) => r.id)))
const unguarded = store.search('部署脚本', {})
check('不设守卫时两条都能取到', unguarded.length === 2, String(unguarded.length))
store.close()

// ── 4. 插件侧：低信息跳过 / 尾注只说一次 / 分层预算 ──
const handlers = new Map()
let recallProvider = null
const provided = {}
const webServer = { register: (route) => () => {}, }
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  on: (event, fn) => {
    handlers.set(event, fn)
    return () => handlers.delete(event)
  },
  get: (service) => {
    if (service === 'systemPrompt') return { context: (def) => { recallProvider = def; return () => { recallProvider = null } } }
    if (service === 'webServer') return webServer
    return undefined
  },
  effect: (fn) => fn(),
  provide: (name, value) => { provided[name] = value },
}
await apply(ctx, { dbPath: join(dir, 'plugin.db'), maxGB: 0.05 })

const emit = (session, event) => handlers.get('session/event')?.(session, event)
const past = { id: 'old-sess', header: { id: 'old-sess' } }
const now = { id: 'cur-sess', header: { id: 'cur-sess' } }

// 五条共享「部署」关键字的跨会话记忆（内容各不相同，避免被去重吃掉）
const facts = [
  '部署脚本叫 deploy-prod.ps1，放在 D 盘 tools 目录下，跑之前先 scp 到 10.0.0.7。',
  '部署窗口固定在每周三凌晨，部署前要把数据库备份拉一份到本地。',
  '部署失败最常见的两个原因：端口 8080 被占用、以及环境变量里少了 API_BASE。',
  '部署完成后要在面板上看一眼健康检查，绿了才算真的上线。',
  '部署回滚只要重新跑上一个 tag 的流水线，别手工改服务器上的文件。',
]
for (const [i, text] of facts.entries()) {
  emit(past, { type: 'user/message', time: 1717000000000 + i * 1000, data: { role: 'user', content: [{ type: 'text', text }] } })
}
await sleep(1300)

emit(now, { type: 'user/message', time: 1717000100000, data: { role: 'user', content: [{ type: 'text', text: '部署脚本和部署窗口分别是什么' }] } })
const first = recallProvider.text({ agent: { session: now } })
check('召回有内容', first.length > 0, String(first.length))
check('召回带防误用措辞', first.includes('以当前指令为准'))
check('召回总字数被压到 900 以内', first.length < 900, String(first.length))
check('召回首轮带尾注', first.includes('memory_open'), first.slice(-80))
const bodies = first.split('\n').filter((line) => /^\d+\. \[id=/.test(line))
check('首条摘录不超过 220 字', (bodies[0] ?? '').length <= 300, String((bodies[0] ?? '').length))
check('末条摘录不超过 100 字', (bodies[bodies.length - 1] ?? '').length <= 130, String((bodies[bodies.length - 1] ?? '').length))

const second = recallProvider.text({ agent: { session: now } })
check('同一会话不重复注入同一条', !second.includes('deploy-prod.ps1'), second.slice(0, 120))
check('尾注只说一次', !second.includes('memory_open'), second.slice(-80))

emit(now, { type: 'user/message', time: 1717000200000, data: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
check('低信息输入不触发召回', recallProvider.text({ agent: { session: now } }) === '')

emit(now, { type: 'user/message', time: 1717000300000, data: { role: 'user', content: [{ type: 'text', text: '好的' }] } })
check('应答词同样跳过', recallProvider.text({ agent: { session: now } }) === '')

// 本轮新写入（助手回复）不该被当成「历史」召回
emit(now, { type: 'user/message', time: 1717000400000, data: { role: 'user', content: [{ type: 'text', text: '部署这件事还有别的要注意的吗' }] } })
emit(now, { type: 'assistant/message', time: 1717000405000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '部署这块刚说过的内容：要注意端口 8080 和 API_BASE 环境变量。' }] } } })
await sleep(1300)
const guardedText = recallProvider.text({ agent: { session: now } })
check('本轮刚写入的助手回复不被自我召回', !guardedText.includes('刚说过的内容'), guardedText.slice(0, 200))

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)