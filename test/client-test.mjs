// .probe/client-test.mjs — 不靠浏览器验证 lib/client.js 的注册契约与组件结构。
// 手法：装一个假的 window.__ModuleLoader__ 抓住宿主会拿到的 entry，再给一个最小 React 桩，
// 最后用假 ctx 跑 apply()，断言两个座位（sidebar.panellist / main）都按契约注册。
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) {
    pass += 1
    console.log('  ok   ' + label)
  } else {
    fail += 1
    console.log('  FAIL ' + label + (extra === undefined ? '' : '  ← ' + JSON.stringify(extra)))
  }
}

const FRAGMENT = Symbol('Fragment')
function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}
const reactStub = {
  Fragment: FRAGMENT,
  createElement,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
}

const captured = []
globalThis.window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, rows: 0 }) })

const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
await import(pathToFileURL(file).href)

ok(captured.length === 1, '自注册恰好一次 __ModuleLoader__.load', captured.length)
const entry = captured[0] || {}
ok(entry.id === 'dsh-memory-vault', 'entry.id 是包名', entry.id)
ok(typeof entry.factory === 'function', 'entry.factory 是函数')

const exportsObj = entry.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('客户端代码不该 require 其它模块，却要了 ' + name)
})
ok(exportsObj && typeof exportsObj === 'object', 'factory 返回 exports 对象')
ok(exportsObj.name === 'dsh-memory-vault', 'exports.name 正确', exportsObj.name)
ok(typeof exportsObj.apply === 'function', 'exports.apply 是函数')
ok(Array.isArray(exportsObj.inject), 'exports.inject 是数组（不写死依赖）', exportsObj.inject)

// 假 ctx：只为验证 slots 注册契约
const registrations = []
const injected = []
const scope = {
  slots: {
    inject: (key, fn) => {
      injected.push(key)
      return fn()
    },
    register: (meta, render) => {
      registrations.push({ meta, render })
      return () => {}
    },
  },
}
let injectKeys = []
const ctx = {
  inject: (keys, fn) => {
    injectKeys = keys
    fn(scope)
  },
}

let threw = null
try {
  exportsObj.apply(ctx)
} catch (error) {
  threw = error
}
ok(!threw, 'apply 不抛异常', threw && String(threw.stack || threw))
ok(injectKeys.length === 1 && injectKeys[0] === 'slots', 'apply 通过 ctx.inject(["slots"]) 等服务', injectKeys)
ok(injected.length === 4, '四处 slots.inject 都执行了', injected)
ok(injected[0] === 'sidebar.panellist', '第一处座位是 sidebar.panellist', injected[0])
ok(injected[1] === 'conversation.input.left', '第二处座位是输入区（紧挨完全权限右侧）', injected[1])
ok(injected[2] === 'conversation.input.left' && injected[3] === 'main', '第三、四处座位是文件选择器与 main', injected.slice(2))
ok(registrations.length === 4, '四个座位都 register 成功', registrations.length)

const [iconReg, fileReg, modeReg, panelReg] = registrations
ok(iconReg && iconReg.meta.name === 'sidebar.panellist', '图标注册名 = sidebar.panellist', iconReg && iconReg.meta.name)
ok(iconReg && iconReg.meta.id === 'dsh-memory-vault', '图标 id = 面板 id', iconReg && iconReg.meta.id)
ok(iconReg && Number.isFinite(iconReg.meta.order), '图标 order 是有限数', iconReg && iconReg.meta.order)
ok(iconReg && typeof iconReg.meta.label === 'function', '图标 label 是函数')

const label = iconReg && iconReg.meta.label()
ok(typeof label === 'string' && label.length > 0, 'label() 返回非空字符串', label)

ok(fileReg && fileReg.meta.name === 'conversation.input.left' && String(fileReg.meta.id).endsWith('-file'), '文件选择器注册在输入区', fileReg && fileReg.meta.id)
ok(modeReg && modeReg.meta.name === 'conversation.input.left', '模式选择器注册名 = conversation.input.left', modeReg && modeReg.meta.name)
ok(modeReg && String(modeReg.meta.id).indexOf('dsh-memory-vault') === 0, '模式选择器 id 归属本插件', modeReg && modeReg.meta.id)

ok(panelReg && panelReg.meta.name === 'main', '面板注册名 = main', panelReg && panelReg.meta.name)
ok(panelReg && panelReg.meta.key === exportsObj.__panel.PANEL_ID, '面板 key 与 PANEL_ID 一致', panelReg && panelReg.meta.key)

// 组件能渲染出树（不需要真 react-dom）
const tree = iconReg.render({ size: 20, active: false, ctx: scope })
ok(tree && typeof tree === 'object', '图标组件返回元素树')
const panelTree = panelReg.render({ ctx: scope, active: true })
ok(panelTree && typeof panelTree === 'object', '面板组件返回元素树')

function flatten(node, out = []) {
  if (node == null || typeof node !== 'object') {
    if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out)
    return out
  }
  flatten(node.props && node.props.children, out)
  return out
}
// 座位 render 只是把组件包一层（元素 type 是 Panel 函数本身），所以要直接调组件才拿得到子树。
const directTree = exportsObj.__panel.Panel({ ctx: scope, active: true })
const texts = flatten(directTree).join(' ')
ok(texts.includes('长期记忆'), '面板标题出现「长期记忆」', texts.slice(0, 80))
ok(exportsObj.__panel.API === '/memory-vault', 'API 前缀 = /memory-vault', exportsObj.__panel.API)

// ── 带数据的渲染 + 交互（目录 / 点开卡片 / 加载更多）──
// factory 每次调用都重新求值闭包，所以能换一份假 react 来注入「已加载数据」的 state。
const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: (init && init.method) || 'GET' })
  return {
    ok: true,
    json: async () => ({
      ok: true,
      entry: { id: 2, ts: Date.now(), session: 's2', role: 'assistant', title: 'B', body: '第二条的完整正文 migrate', chars: 12, bytes: 90, hits: 3 },
    }),
  }
}
const RICH = {
  loading: false,
  error: '',
  stats: { rows: 2, bytes: 1024, maxMB: 5120, maxGB: 5, usedPercent: 0.02, quotaSource: 'config', presetsGB: [1, 5, 10, 20, 50], dbPath: 'D:/x.db', newest: Date.now() },
  results: [],
  recent: [
    { id: 1, ts: Date.now(), session: 'session-aaaa', role: 'user', title: 'A 条', snippet: '摘要一', chars: 30, hits: 1 },
    { id: 2, ts: Date.now() - 1000, session: 'session-bbbb', role: 'assistant', title: 'B 条', snippet: '摘要二', chars: 12, hits: 0 },
  ],
  total: 2,
  catalog: {
    total: 2,
    days: [{ day: '2026-10-20', count: 2, bytes: 1024, newest: Date.now() }],
    sessions: [
      { session: 'session-aaaa', count: 1, newest: Date.now() },
      { session: 'session-bbbb', count: 1, newest: Date.now() - 1000 },
    ],
  },
  filter: { day: '', session: '' },
  expanded: { 1: true },
  details: { 1: { id: 1, body: '第一条的完整正文 deploy', hits: 1, bytes: 500 } },
}
function makeReact(override) {
  let first = true
  return {
    ...reactStub,
    useState: (init) => {
      if (first) {
        first = false
        return [override, () => {}]
      }
      return [typeof init === 'function' ? init() : init, () => {}]
    },
  }
}
const richExports = entry.factory((n) => {
  if (n === 'react') return makeReact(RICH)
  throw new Error('不该 require ' + n)
})
let richTree = null
let richThrew = null
try {
  richTree = richExports.__panel.Panel({ ctx: scope, active: true })
} catch (e) {
  richThrew = e
}
ok(richThrew === null, '带数据渲染不抛异常', richThrew && String(richThrew.stack || richThrew))
const richText = flatten(richTree).join(' ')
ok(richText.includes('目录 · 2 条'), '渲染出「目录」区块', richText.slice(0, 120))
ok(richText.includes('2026-10-20 · 2'), '目录有按天切片', richText.slice(0, 200))
ok(richText.includes('会话') && richText.includes('session-'.slice(0, 7)), '目录有按会话切片')
ok(richText.includes('收起'), '已展开那条显示「收起」')
ok(richText.includes('展开'), '未展开那条显示「展开」')
ok(richText.includes('第一条的完整正文 deploy'), '展开的卡片直接显示全文', richText.slice(0, 300))
ok(richText.includes('5 GB') && richText.includes('容量上限 5 GB'), '容量档位仍在')

// 找到「展开」那张卡片（B 条）并点击 → 应按需取全文
function findClickable(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findClickable(n, out)
    return out
  }
  if (node.props && typeof node.props.onClick === 'function' && node.props.tabIndex === 0) out.push(node)
  findClickable(node.props && node.props.children, out)
  return out
}
const cards = findClickable(richTree)
ok(cards.length === 2, '两张卡片都可点击（role=button + tabIndex=0）', String(cards.length))
const target = cards.find((c) => flatten(c).join(' ').includes('B 条'))
ok(!!target, '找到 B 条卡片')
if (target) {
  target.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
  const hit = calls.find((c) => c.url.includes('/entry?id=2'))
  ok(!!hit, '点击后按需请求 /entry?id=2', JSON.stringify(calls))
  ok(calls.length === 1, '只取该条，不会把整本库拉下来', JSON.stringify(calls.map((c) => c.url)))
  ok(typeof target.props.onKeyDown === 'function', '卡片支持键盘操作（onKeyDown）')
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
if (fail > 0) process.exitCode = 1