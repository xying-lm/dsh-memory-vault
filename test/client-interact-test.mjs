// 面板交互测试：用最小 React 运行时真渲染 + 真点按钮。
// 覆盖「点目录 chip 后重新渲染」这条路径 —— 静态渲染测试抓不到，
// 而这里恰好藏过一个致命 bug：`chip('clear', …)` 少传了 ui，过滤一激活就抛错、整块面板空白。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = resolve(here, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const ok = (label, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label} ${detail}`)
  }
}

// ── 最小 hook 运行时（支持 setState 触发重渲染）──
let hooks = []
let cursor = 0
let scheduled = false
let dirty = false

function schedule() {
  dirty = true
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    if (dirty) {
      dirty = false
      renderTree()
    }
  })
}

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }
  },
  useState(initial) {
    const i = cursor++
    if (hooks[i] === undefined) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = hooks[i]
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      schedule()
    }
    return [slot.value, set]
  },
  useEffect(fn, deps) {
    const i = cursor++
    const prev = hooks[i]
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k])
    hooks[i] = { deps, pending: changed ? fn : undefined }
  },
  useRef(v) {
    const i = cursor++
    if (hooks[i] === undefined) hooks[i] = { current: v }
    return hooks[i]
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

// ── 假后端 ──
const ROWS = Array.from({ length: 3 }, (_, k) => ({
  id: k + 1,
  ts: 1792511680616 - k * 1000,
  session: 'session-aaaa',
  role: 'user',
  title: 't' + k,
  snippet: '摘要 ' + (k + 1),
  chars: 40,
  hits: 1,
  mode: 'long',
}))
const calls = []
const posts = []
globalThis.fetch = async (url, init) => {
  const path = String(url)
  const method = (init && init.method) || 'GET'
  calls.push(path)
  if (method !== 'GET') posts.push({ path, method, body: (init && init.body) || '' })
  const json = (v) => ({ ok: true, json: async () => v })
  if (path.includes('/session-mode')) {
    if (method !== 'GET') {
      const parsed = JSON.parse((init && init.body) || '{}')
      return json({ ok: true, session: parsed.session, mode: parsed.mode, modes: ['long', 'multi', 'once'] })
    }
    return json({ ok: true, mode: 'long', modes: ['long', 'multi', 'once'], defaultMode: 'long' })
  }
  if (path.includes('/stats')) {
    return json({
      ok: true,
      rows: 3,
      usedMB: 0.1,
      maxMB: 5120,
      maxGB: 5,
      usedPercent: 1,
      quotaSource: 'config',
      presetsGB: [1, 5, 10, 20, 50],
      newest: 1792511680616,
      dbPath: 'x',
    })
  }
  if (path.includes('/catalog')) {
    return json({
      ok: true,
      total: 3,
      days: [{ day: '2026-10-20', count: 3, bytes: 120, newest: 1792511680616 }],
      sessions: [
        { session: 'session-aaaa', count: 3, newest: 1792511680616 },
        { session: 'im:qq_0cfa7d', count: 1, newest: 1792511680000 },
      ],
    })
  }
  if (path.includes('/recent')) return json({ ok: true, total: 3, offset: 0, limit: 20, results: ROWS })
  if (path.includes('/entry')) return json({ ok: true, id: 1, body: '全文', chars: 2, bytes: 6, hits: 1 })
  return json({ ok: true, results: [] })
}

// ── 载入 bundle ──
const captured = []
globalThis.window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
new Function('window', readFileSync(lib, 'utf8'))(globalThis.window)
const entry = captured[0]
ok('bundle 注册了 factory', typeof entry?.factory === 'function')
const mod = entry.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
})
const { Panel } = mod.__panel

let tree = null
let activeComponent = null
let activeProps = {}
function renderTree() {
  cursor = 0
  tree = activeComponent(activeProps)
  for (const hook of hooks) {
    if (hook && hook.pending) {
      const fn = hook.pending
      hook.pending = null
      fn()
    }
  }
  return tree
}
activeComponent = Panel
activeProps = { ctx: {} }

const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}
const findAll = (node, out = []) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out
  out.push(node)
  for (const c of node.children || []) findAll(c, out)
  return out
}
const cards = () => findAll(tree).filter((n) => n.props && n.props.role === 'button' && n.props.tabIndex === 0)
const buttons = (prefix) => findAll(tree).filter((n) => n.type === 'button' && String(textOf(n)).startsWith(prefix))

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10))
}

// ── 初次渲染 ──
renderTree()
await flush()
renderTree()
ok('初次渲染出 3 张记忆卡', cards().length === 3, String(cards().length))
ok('初次标题是「最近写入」', textOf(tree).includes('最近写入'))
ok('目录区渲染出日期 chip', buttons('2026-10-20 ·').length === 1)
ok('目录区渲染出会话 chip', buttons('im:qq_0c').length === 1)

// ── 点日期 chip（这一步以前会抛 TypeError，整块面板空白）──
let threw = ''
try {
  buttons('2026-10-20 ·')[0].props.onClick()
  await flush()
  renderTree()
} catch (error) {
  threw = error?.message ?? String(error)
}
ok('点日期 chip 不抛错', threw === '', threw)
ok('点完仍然渲染出 3 张卡（不是空白）', cards().length === 3, String(cards().length))
const filtered = textOf(tree)
ok('标题变成「目录 · 2026-10-20（3 条）」', /目录 · 2026-10-20（3 条）/.test(filtered), filtered.slice(0, 120))
ok('出现「取消筛选」', filtered.includes('取消筛选'))
ok('筛选请求真的带上了 day 参数', calls.some((u) => u.includes('day=2026-10-20')), JSON.stringify(calls.slice(-3)))

// ── 取消筛选 ──
threw = ''
try {
  buttons('取消筛选')[0].props.onClick()
  await flush()
  renderTree()
} catch (error) {
  threw = error?.message ?? String(error)
}
ok('点「取消筛选」不抛错', threw === '', threw)
ok('回到全部记忆（标题恢复「最近写入」）', textOf(tree).includes('最近写入'))
ok('取消后仍渲染出 3 张卡', cards().length === 3, String(cards().length))

// ── 点会话 chip ──
threw = ''
try {
  buttons('im:qq_0c')[0].props.onClick()
  await flush()
  renderTree()
} catch (error) {
  threw = error?.message ?? String(error)
}
ok('点会话 chip 不抛错', threw === '', threw)
ok('会话筛选后仍有卡片', cards().length === 3, String(cards().length))
ok('请求带上了 session 参数', calls.some((u) => u.includes('session=im%3Aqq_0cfa7d')), JSON.stringify(calls.slice(-3)))

// ── 输入区记忆模式选择器（conversation.input.left，紧挨「完全权限」右侧）──
const { ModeChip } = mod.__panel
hooks = []
cursor = 0
tree = null
function renderChip(props) {
  activeComponent = ModeChip
  activeProps = props
  return renderTree()
}

renderChip({ sessionId: 'session-aaaa' })
await flush()
renderChip({ sessionId: 'session-aaaa' })
ok('选择器初次挂载就去问宿主当前模式', calls.some((u) => u.includes('/session-mode?session=session-aaaa')), JSON.stringify(calls.slice(-2)))
ok('选择器显示「长期」', textOf(tree).includes('长期'), textOf(tree))
ok('未点开时没有选项列表', findAll(tree).filter((n) => n.props && n.props.role === 'option').length === 0)

const chipBtn = findAll(tree).find((n) => n.type === 'button' && textOf(n).includes('记忆'))
ok('找到选择器按钮', !!chipBtn)
threw = ''
try {
  chipBtn.props.onClick()
  await flush()
  renderChip({ sessionId: 'session-aaaa' })
} catch (error) {
  threw = error?.message ?? String(error)
}
ok('点开选择器不抛错', threw === '', threw)
const options = findAll(tree).filter((n) => n.props && n.props.role === 'option')
ok('点开后列出三种模式', options.length === 3, String(options.length))
ok('选项里有「本会话」', textOf(tree).includes('本会话'))
ok('选项里有「单次」', textOf(tree).includes('单次'))

const onceOpt = options.find((n) => textOf(n).includes('单次'))
threw = ''
try {
  onceOpt.props.onClick()
  await flush()
  renderChip({ sessionId: 'session-aaaa' })
} catch (error) {
  threw = error?.message ?? String(error)
}
ok('点「单次」不抛错', threw === '', threw)
ok('POST /session-mode 带上了 session', posts.some((p) => p.path.includes('/session-mode') && p.body.includes('session-aaaa')), JSON.stringify(posts))
ok('POST /session-mode 带上了 mode=once', posts.some((p) => p.body.includes('"once"')), JSON.stringify(posts))
ok('选完按钮显示「单次」', textOf(tree).includes('单次'), textOf(tree))
ok('选完自动收起列表', findAll(tree).filter((n) => n.props && n.props.role === 'option').length === 0)

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)