// .probe/resize-test.mjs — 容量可调（档位 + 自定义 + 落库持久化 + 面板 POST /resize）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

import { MemoryStore, SIZE_PRESETS, gigabytesToBytes, MIN_BYTES, MAX_BYTES } from '../lib/store.js'
import { registerPanel } from '../lib/panel.js'
import { resolveMaxBytes } from '../lib/index.js'

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
function throws(fn, label) {
  try {
    fn()
    ok(false, label + '（没抛）')
  } catch {
    ok(true, label)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'vault-resize-'))
const dbPath = join(dir, 'vault.db')

ok(JSON.stringify(SIZE_PRESETS) === JSON.stringify([1, 5, 10, 20, 50]), '档位是 1/5/10/20/50', SIZE_PRESETS)
ok(gigabytesToBytes(5) === 5 * 1024 ** 3, 'gigabytesToBytes(5) = 5GiB')
ok(gigabytesToBytes(0.01) === null, '低于 50MB 返回 null')
ok(gigabytesToBytes(NaN) === null, 'NaN 返回 null')

// 配置 → 配额
ok(resolveMaxBytes({ sizePreset: '10', maxGB: 3 }) === 10 * 1024 ** 3, '档位优先于 maxGB', resolveMaxBytes({ sizePreset: '10', maxGB: 3 }))
ok(resolveMaxBytes({ sizePreset: 'custom', maxGB: 2.5 }) === Math.round(2.5 * 1024 ** 3), 'custom 时用 maxGB')
ok(resolveMaxBytes({ sizePreset: 'custom', maxGB: 999 }) === 5 * 1024 ** 3, '越界 maxGB 回落 5GiB')
ok(resolveMaxBytes({}) === 5 * 1024 ** 3, '空配置 = 5GiB')

let store = new MemoryStore({ dbPath, maxBytes: 5 * 1024 ** 3 })
ok(store.maxBytes === 5 * 1024 ** 3 && store.quotaSource === 'config', '默认配额来自配置')

// 落库：写入若干条再缩小到 50MB
for (let i = 0; i < 30; i++) store.save({ ts: 1000 + i, session: 's1', role: 'assistant', body: `第 ${i} 条记忆 ` + '内容'.repeat(400) })
ok(store.stats().rows === 30, '写入 30 条', store.stats().rows)

const shrunk = store.setQuotaGB(0.05)
ok(shrunk.maxGB === 0.05, '缩到 0.05GB（50MB 下限）', shrunk.maxGB)
ok(shrunk.quotaSource === 'override', '来源标记为手动设定')
ok(shrunk.rows === 30, '数据远小于 50MB 下限，缩小不该误删（正确语义）', shrunk.rows)
ok(shrunk.rows >= 1, '至少保留一条', shrunk.rows)
ok(store.stats().bytes <= 0.05 * 1024 ** 3, '体积已回到配额内')

// 重启（重新打开同一个库）后设置仍在
store.close()
store = new MemoryStore({ dbPath, maxBytes: 5 * 1024 ** 3 })
ok(store.maxBytes === gigabytesToBytes(0.05), '重开后仍是手动设定的容量', store.maxBytes)
ok(store.quotaSource === 'override', '重开后来源仍是 override')

// 放大 + 常用档位
const grown = store.setQuotaGB(10)
ok(grown.maxGB === 10, '放大到 10GB', grown.maxGB)
ok(SIZE_PRESETS.includes(grown.maxGB), '10 属于常用档位')

// 非法输入
throws(() => store.setQuotaGB(0), '0GB 抛 RangeError')
throws(() => store.setQuotaGB(500), '500GB 抛 RangeError')
throws(() => store.setQuotaGB('abc'), '非数字抛 RangeError')
ok(MIN_BYTES === 50 * 1024 * 1024 && MAX_BYTES === 200 * 1024 ** 3, '区间常量 = 50MB ~ 200GB')

// 恢复配置值
const restored = store.clearQuotaOverride()
ok(restored.maxGB === 5, '恢复配置值后回到 5GB', restored.maxGB)
ok(store.quotaSource === 'config', '恢复后来源 = config')

// ── 面板 POST /resize ──
const server = http.createServer((req, res) => handler(req, res))
let handler = () => {}
const mounted = registerPanel(
  {
    get: () => ({
      register: (route) => {
        handler = route.handler
        return () => {}
      },
    }),
  },
  store,
  () => {},
)
ok(mounted === undefined || typeof mounted === 'function', 'registerPanel 正常返回')

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/memory-vault`

const statsRes = await fetch(base + '/stats')
const statsBody = await statsRes.json()
ok(statsBody.ok === true && Array.isArray(statsBody.presetsGB), 'GET /stats 带 presetsGB', statsBody.presetsGB)

const post = (body) =>
  fetch(base + '/resize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

let r = await post({ gigabytes: 20 })
let j = await r.json()
ok(r.status === 200 && j.ok === true, 'POST /resize 20GB → 200', r.status)
ok(j.maxGB === 20 && j.quotaSource === 'override', '返回新的容量与来源', { maxGB: j.maxGB, src: j.quotaSource })
ok(store.maxBytes === 20 * 1024 ** 3, '内存里的配额同步变了')

r = await post({ gigabytes: 2.5 })
j = await r.json()
ok(r.status === 200 && j.maxGB === 2.5, '自定义 2.5GB 生效', j.maxGB)

r = await post({ gigabytes: 0 })
j = await r.json()
ok(r.status === 400 && j.ok === false, '0GB → 400', r.status)

r = await post({ gigabytes: 999 })
j = await r.json()
ok(r.status === 400 && j.ok === false, '999GB → 400', r.status)

r = await fetch(base + '/resize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
ok(r.status === 400, '坏 JSON → 400', r.status)

r = await post({ reset: true })
j = await r.json()
ok(r.status === 200 && j.maxGB === 5 && j.quotaSource === 'config', 'reset 回到配置值', { maxGB: j.maxGB, src: j.quotaSource })

r = await fetch(base + '/stats', { method: 'POST' })
ok(r.status === 405, 'POST /stats 仍是 405', r.status)

r = await fetch(base + '/search?q=' + encodeURIComponent('记忆') + '&limit=3')
j = await r.json()
ok(r.status === 200 && Array.isArray(j.results), 'GET /search 仍正常', r.status)

await new Promise((resolve) => server.close(resolve))
store.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} pass / ${fail} fail`)
if (fail > 0) process.exitCode = 1