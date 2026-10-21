// lib/panel.js — dsh-memory-vault 浏览器面板的宿主半边（只读 HTTP 面）。
//
// 契约出处（本机实测的官方实现，不是猜的）：
//   · 路由 = `ctx.webServer.register({ kind:'prefix', path, handler })`，`kind` ∈ exact|prefix，
//     handler **拥有完整响应生命周期**（自己 writeHead / end）。
//   · **裸读 `ctx.webServer` 会抛** `cannot get property "webServer" without inject`；
//     一律走 `ctx.get('webServer')`（服务迟到时退回 `ctx.inject(['webServer'], …)` 等待）。
//   · 同一 (kind, path) 重复注册会抛 `webserver: duplicate prefix route "…"` —— 卸载时必须收回 disposer。
//
// 安全口径：读路由只读（stats / search / recent / catalog / entry / session-mode / threads / thread / location），
// 不读任何凭据；写路由都碰不到记忆正文：POST /resize 改「容量上限」、POST /session-mode 改
// 「本会话的记忆模式」、POST /threads 新建对话文件、POST /session-thread 把会话挂到文件、
// POST /location 改「库文件位置」（只搬 SQLite 文件，不改内容）。
// 整面随 `ctx.webServer` 的监听地址暴露（本机默认回环 127.0.0.1）。

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

const ROUTE = '/memory-vault'
const MAX_BODY = 4096

/** 取服务而不触发 cordis 的「未 inject 就取」硬错误。 */
function peek(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    status = 500
    body = JSON.stringify({ ok: false, error: `序列化失败：${error?.message ?? error}` })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readQuery(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    return { path: url.pathname, params: url.searchParams, query: url.searchParams }
  } catch {
    return { path: '', params: new URLSearchParams(), query: new URLSearchParams() }
  }
}

function limitOf(params, fallback, max) {
  const raw = Number(params.get('limit') ?? NaN)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.max(1, Math.min(Math.floor(raw), max))
}

/** 读 JSON 请求体，带体积上限 —— 这个面只该收到几十字节的 {gigabytes}。 */
function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    let size = 0
    let over = false
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        over = true
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (over) return resolve({ error: `请求体超过 ${limit} 字节` })
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({ value: {} })
      try {
        const value = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return resolve({ error: '请求体应为 JSON 对象' })
        resolve({ value })
      } catch {
        resolve({ error: '请求体不是合法 JSON' })
      }
    })
    req.on('error', () => resolve({ error: '读取请求体失败' }))
  })
}

/**
 * 挂上只读面板路由。
 * @param {object} options 会话级记忆模式的读写钩子（由 index.js 注入）
 *   - getSessionMode(sessionId) → 'long' | 'multi' | 'once'
 *   - setSessionMode(sessionId, mode) → mode（非法值抛错）
 *   - modes / defaultMode 用于回显可选集合
 * @returns {(() => void) | undefined} disposer（宿主卸载时调用）
 */
export function registerPanel(ctx, store, log = () => {}, options = {}) {
  const getSessionMode = typeof options.getSessionMode === 'function' ? options.getSessionMode : () => options.defaultMode ?? 'long'
  const setSessionMode = typeof options.setSessionMode === 'function' ? options.setSessionMode : null
  const modes = Array.isArray(options.modes) && options.modes.length > 0 ? options.modes : ['long', 'multi', 'once']
  const handler = (req, res) => {
    const { path, params } = readQuery(req)
    const tail = path.slice(ROUTE.length).replace(/\/+$/, '') || '/'
    try {
      if (req.method === 'POST') {
        if (!['/resize', '/session-mode', '/threads', '/session-thread', '/location'].includes(tail)) {
          sendJson(res, 405, { ok: false, error: '写路由：POST /resize、/session-mode、/threads、/session-thread、/location' })
          return
        }
        if (tail === '/location') {
          void (async () => {
            const body = await readJsonBody(req)
            if (body.error) {
              sendJson(res, 400, { ok: false, error: body.error })
              return
            }
            const input = body.value ?? {}
            try {
              if (input.reset === true) {
                // 恢复默认位置只删「选择」这一步；旧库文件留在原处不动，避免误删数据。
                if (options.sidecar && existsSync(options.sidecar)) rmSync(options.sidecar, { force: true })
                log('info', `· 库位置恢复默认（重启后生效）`)
                sendJson(res, 200, { ok: true, dbPath: options.defaultDbPath ?? '', restart: true })
                return
              }
              const wanted = String(input.path ?? '').trim().replace(/^"|"$/g, '')
              if (!wanted.toLowerCase().endsWith('.db')) {
                sendJson(res, 400, { ok: false, error: '路径要以 .db 结尾' })
                return
              }
              const target = resolvePath(wanted)
              const current = options.dbPath ?? ''
              if (current && target === resolvePath(current)) {
                sendJson(res, 400, { ok: false, error: '新位置和当前位置相同' })
                return
              }
              mkdirSync(dirname(target), { recursive: true })
              // 复制而不是移动：换位置后第一次启动要能完整打开旧数据，而旧文件仍可回退。
              if (current && existsSync(current) && !existsSync(target)) copyFileSync(current, target)
              for (const suffix of ['-wal', '-shm']) {
                if (current && existsSync(current + suffix) && !existsSync(target + suffix)) {
                  copyFileSync(current + suffix, target + suffix)
                }
              }
              writeFileSync(options.sidecar, JSON.stringify({ dbPath: target }, null, 2) + '\n', 'utf8')
              log('info', `· 库位置改为 ${target}（重启后生效）`)
              sendJson(res, 200, { ok: true, dbPath: target, restart: true })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
            }
          })()
          return
        }
        if (tail === '/threads') {
          void (async () => {
            const body = await readJsonBody(req)
            if (body.error) {
              sendJson(res, 400, { ok: false, error: body.error })
              return
            }
            const input = body.value ?? {}
            try {
              const thread = store.createThread({ title: String(input.title ?? '').trim().slice(0, 60) })
              log('info', `· 新建对话文件 ${thread.path}`)
              sendJson(res, 200, { ok: true, thread })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
            }
          })()
          return
        }
        if (tail === '/session-thread') {
          void (async () => {
            const body = await readJsonBody(req)
            if (body.error) {
              sendJson(res, 400, { ok: false, error: body.error })
              return
            }
            const input = body.value ?? {}
            const session = String(input.session ?? '').trim()
            const threadId = Number(input.thread ?? 0)
            if (!session) {
              sendJson(res, 400, { ok: false, error: 'session 不能为空' })
              return
            }
            if (!Number.isInteger(threadId) || threadId <= 0) {
              sendJson(res, 400, { ok: false, error: 'thread 必须是对话文件的正整数 id' })
              return
            }
            try {
              const thread = store.bindThread(session, threadId)
              log('info', `· 会话 ${session.slice(0, 18)} 挂到对话文件 ${thread.path}`)
              sendJson(res, 200, { ok: true, session, thread })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
            }
          })()
          return
        }
        if (tail === '/session-mode') {
          void (async () => {
            const body = await readJsonBody(req)
            if (body.error) {
              sendJson(res, 400, { ok: false, error: body.error })
              return
            }
            const input = body.value ?? {}
            const session = String(input.session ?? '').trim()
            const mode = String(input.mode ?? '').trim()
            if (!session) {
              sendJson(res, 400, { ok: false, error: 'session 不能为空' })
              return
            }
            if (!modes.includes(mode)) {
              sendJson(res, 400, { ok: false, error: `mode 只能是 ${modes.join(' / ')}` })
              return
            }
            if (!setSessionMode) {
              sendJson(res, 503, { ok: false, error: '本宿主未提供会话模式写入' })
              return
            }
            try {
              const applied = setSessionMode(session, mode)
              log('info', `· 会话模式 ${session.slice(0, 18)} → ${applied}`)
              sendJson(res, 200, { ok: true, session, mode: applied, modes })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
            }
          })()
          return
        }
        void (async () => {
          const body = await readJsonBody(req)
          if (body.error) {
            sendJson(res, 400, { ok: false, error: body.error })
            return
          }
          const input = body.value ?? {}
          try {
            let after
            if (input.reset === true) {
              after = store.clearQuotaOverride()
            } else {
              const gb = Number(input.gigabytes)
              if (!Number.isFinite(gb) || gb <= 0) {
                sendJson(res, 400, { ok: false, error: 'gigabytes 要给一个正数（GB）' })
                return
              }
              after = store.setQuotaGB(gb)
            }
            log('info', `· 面板调整容量 → ${after.maxGB}GB（${after.quotaSource}）`)
            sendJson(res, 200, { ok: true, ...after })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        })()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '读路由只接受 GET' })
        return
      }
      if (tail === '/stats' || tail === '/') {
        sendJson(res, 200, { ok: true, ...store.stats() })
        return
      }
      if (tail === '/search') {
        const q = (params.get('q') ?? '').trim()
        const limit = limitOf(params, 8, 50)
        if (q === '') {
          sendJson(res, 200, { ok: true, query: '', results: [] })
          return
        }
        sendJson(res, 200, { ok: true, query: q, results: store.search(q, { limit }) })
        return
      }
      if (tail === '/recent') {
        // 始终走翻页查询：即使 offset=0 / 无筛选也要带 total，
        // 否则面板第一页拿不到总数，「加载更多（还有 N 条）」永远不出现。
        const offset = Number(params.get('offset') ?? 0)
        const day = (params.get('day') ?? '').trim()
        const session = (params.get('session') ?? '').trim()
        const limit = limitOf(params, 20, 200)
        const page = store.recentPage({ limit, offset, day, session })
        sendJson(res, 200, { ok: true, total: page.total, offset: page.offset, limit: page.limit, results: page.rows })
        return
      }
      if (tail === '/session-mode') {
        const session = (params.get('session') ?? '').trim()
        sendJson(res, 200, {
          ok: true,
          session,
          mode: getSessionMode(session),
          modes,
          defaultMode: options.defaultMode ?? modes[0],
        })
        return
      }
      if (tail === '/catalog') {
        const page = store.catalog()
        sendJson(res, 200, { ok: true, ...page })
        return
      }
      if (tail === '/location') {
        sendJson(res, 200, {
          ok: true,
          dbPath: options.dbPath ?? store.stats().dbPath,
          defaultDbPath: options.defaultDbPath ?? '',
          custom: Boolean(options.sidecar && existsSync(options.sidecar)),
        })
        return
      }
      if (tail === '/threads') {
        const session = (params.get('session') ?? '').trim()
        const current = session ? store.threadOfSession(session) : null
        sendJson(res, 200, { ok: true, current, threads: store.listThreads({ limit: limitOf(params, 50, 200) }) })
        return
      }
      if (tail === '/thread') {
        const id = Number(params.get('id') ?? 0)
        if (!Number.isInteger(id) || id <= 0) {
          sendJson(res, 400, { ok: false, error: 'id 必须是正整数' })
          return
        }
        const thread = store.getThread(id)
        if (!thread) {
          sendJson(res, 404, { ok: false, error: `没有 id=${id} 的对话文件` })
          return
        }
        const digest = store.threadDigest(id, { recentTurns: limitOf(params, 8, 50) })
        sendJson(res, 200, { ok: true, thread, digest })
        return
      }
      if (tail === '/entry') {
        const id = Number(params.get('id') ?? 0)
        if (!Number.isInteger(id) || id <= 0) {
          sendJson(res, 400, { ok: false, error: 'id 必须是正整数' })
          return
        }
        const entry = store.getById(id)
        if (!entry) {
          sendJson(res, 404, { ok: false, error: `没有 id=${id} 的记忆` })
          return
        }
        sendJson(res, 200, { ok: true, entry })
        return
      }
      sendJson(res, 404, { ok: false, error: `未知路径 ${tail}` })
    } catch (error) {
      log('warn', `· 面板路由处理失败 ${tail}：${error?.stack ?? error}`)
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        /* 响应已发出或连接已断，忽略 */
      }
    }
  }

  const mount = (host) => {
    if (typeof host?.register !== 'function') {
      log('warn', '· 面板路由未注册：webServer.register 不是函数')
      return undefined
    }
    try {
      const dispose = host.register({ kind: 'prefix', path: ROUTE, handler })
      log('info', `· 面板路由已挂载 ${ROUTE}/*`)
      return dispose
    } catch (error) {
      log('warn', `· 面板路由注册失败：${error?.message ?? error}`)
      return undefined
    }
  }

  const now = peek(ctx, 'webServer')
  if (typeof now?.register === 'function') return mount(now)

  if (typeof ctx?.inject !== 'function') {
    log('warn', '· 面板路由跳过：本 ctx 既无 webServer 也无 inject（无 Web 载体的组合）')
    return undefined
  }

  let dispose
  try {
    ctx.inject(['webServer'], (scope) => {
      const host = peek(scope, 'webServer') ?? peek(ctx, 'webServer')
      dispose = mount(host)
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        try {
          ctx.effect(() => dispose)
        } catch {
          /* 宿主无 effect → 交给宿主生命周期 */
        }
      }
    })
  } catch (error) {
    log('warn', `· 面板路由 inject 失败：${error?.message ?? error}`)
  }
  return undefined
}

export const PANEL_ROUTE = ROUTE