// lib/client.js — dsh-memory-vault 浏览器半边（手写 lazy-CJS，零构建链，只 require('react')）。
//
// 契约出处（本机已装插件的实测实现）：
//   · 浏览器半边由 `package.json` 的 `dsh.client` + `exports["./client"]` 送出；
//   · 产物必须是一段 lazy-CJS：`window.__ModuleLoader__.load({ id, factory: (require) => … })`；
//     factory 返回 cordis-plugin 形状（`exports.apply` / `exports.inject`）；
//   · 座位：`sidebar.panellist`（list，全局面板图标）+ `main`（keyed，中央面板）。
//     两者都通过 `ctx.inject(['slots'], scope => scope.slots.inject(<slot>, () => scope.slots.register(...)))` 注册；
//   · 数据来源：宿主半边的**只读** HTTP 面 `/memory-vault/*`（见 lib/panel.js）——
//     不直连文件系统、不读凭据、不发写请求。
//
// 失败口径：任何一步失败都只影响对应座位，并把原因显示在面板页脚（不静默失效）。
window.__ModuleLoader__.load({
  id: 'dsh-memory-vault',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var h = react.createElement

    var PANEL_ID = 'dsh-memory-vault'
    var API = '/memory-vault'
    var PAGE = 20
    var SEATS = { main: false, icon: false, mode: false, error: '' }

    // ── 主题色：用官方 token，取不到就退回中性色（别把颜色写死成某一个主题） ──
    function T(name, fallback) {
      return 'var(' + name + ', ' + fallback + ')'
    }
    var C = {
      text: T('--dsw-alias-label-primary', '#1a202c'),
      sub: T('--dsw-alias-label-secondary', '#5a6472'),
      line: T('--dsw-alias-border-l2', '#d0d5dd'),
      bg: T('--dsw-alias-bg-l1', '#ffffff'),
      soft: T('--dsw-alias-bg-l2', '#f4f6f8'),
      accent: T('--dsw-alias-brand-primary', '#3b6ef5'),
      danger: T('--dsw-alias-state-error-primary', '#d64545'),
    }

    // ── 数据面：只读 GET ──
    function get(path) {
      return fetch(API + path, { method: 'GET', headers: { accept: 'application/json' } }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    // 唯一的写请求：改容量上限。库内容一个字节都不动。
    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || data.ok === false) throw new Error((data && data.error) || 'HTTP ' + res.status)
          return data
        })
      })
    }

    function fmtBytes(n) {
      var v = Number(n) || 0
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    function fmtTime(ts) {
      var d = new Date(Number(ts) || 0)
      if (!isFinite(d.getTime())) return '—'
      function p(n) {
        return String(n).padStart(2, '0')
      }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    // ── 侧栏图标 ──
    function PanelIcon(props) {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M5 6.5C5 4.6 6.6 3 8.5 3h7C17.4 3 19 4.6 19 6.5v11c0 1.9-1.6 3.5-3.5 3.5h-7C6.6 21 5 19.4 5 17.5z' }),
        h('path', { d: 'M9 8h6M9 12h6M9 16h3' })
      )
    }

    // ── 主面板 ──
    function Panel(props) {
      var state = react.useState({
        loading: true,
        error: '',
        stats: null,
        results: [],
        recent: [],
        total: 0,
        catalog: null,
        filter: { day: '', session: '' },
        expanded: {},
        details: {},
      })
      var s = state[0]
      var set = state[1]
      var qs = react.useState('')
      var q = qs[0]
      var setQ = qs[1]
      var cs = react.useState('')
      var cap = cs[0]
      var setCap = cs[1]

      // 异步回调里读到的 s 是创建回调那次渲染的快照，合并时必须拿最新值，否则会互相覆盖字段。
      var ref = (react.useRef ? react.useRef(s) : null) || { current: s }
      ref.current = s
      function patch(extra) {
        var next = Object.assign({}, ref.current, extra || {})
        ref.current = next
        set(next)
      }

      function pageUrl(offset, filter) {
        var f = filter || ref.current.filter || { day: '', session: '' }
        var parts = ['limit=' + PAGE, 'offset=' + (offset || 0)]
        if (f.day) parts.push('day=' + encodeURIComponent(f.day))
        if (f.session) parts.push('session=' + encodeURIComponent(f.session))
        return '/recent?' + parts.join('&')
      }

      function load() {
        patch({ loading: true, error: '' })
        Promise.all([get('/stats'), get('/catalog'), get(pageUrl(0, { day: '', session: '' }))])
          .then(function (out) {
            var page = out[2] || {}
            patch({
              loading: false,
              error: '',
              stats: out[0],
              catalog: out[1],
              recent: page.results || [],
              total: Number(page.total) || (page.results || []).length,
              filter: { day: '', session: '' },
              expanded: {},
              details: {},
            })
            if (out[0] && out[0].maxGB !== undefined) setCap(String(out[0].maxGB))
          })
          .catch(function (e) {
            patch({ loading: false, error: String((e && e.message) || e) })
          })
      }

      // 目录筛选 / 加载更多：都只是把 offset 与筛选条件换成新的一页
      function loadPage(offset, filter) {
        patch({ loading: true, error: '' })
        get(pageUrl(offset, filter))
          .then(function (out) {
            var rows = offset > 0 ? (ref.current.recent || []).concat(out.results || []) : out.results || []
            patch({ loading: false, error: '', recent: rows, total: Number(out.total) || rows.length, filter: filter || ref.current.filter })
          })
          .catch(function (e) {
            patch({ loading: false, error: String((e && e.message) || e) })
          })
      }

      function applyFilter(day, session) {
        loadPage(0, { day: day || '', session: session || '' })
      }

      function search() {
        var text = String(q || '').trim()
        if (text === '') {
          patch({ loading: false, error: '', results: [] })
          return
        }
        patch({ loading: true, error: '' })
        get('/search?limit=10&q=' + encodeURIComponent(text))
          .then(function (out) {
            patch({ loading: false, error: '', results: out.results || [] })
          })
          .catch(function (e) {
            patch({ loading: false, error: String((e && e.message) || e), results: [] })
          })
      }

      // 点开一条卡片：第一次点才去宿主取全文（列表接口故意不带正文）
      function toggle(row) {
        var id = row && row.id
        if (!id) return
        var expanded = Object.assign({}, ref.current.expanded || {})
        if (expanded[id]) {
          delete expanded[id]
          patch({ expanded: expanded })
          return
        }
        expanded[id] = true
        var cached = (ref.current.details || {})[id]
        if (cached && cached.body !== undefined) {
          patch({ expanded: expanded })
          return
        }
        var details = Object.assign({}, ref.current.details || {})
        details[id] = { loading: true }
        patch({ expanded: expanded, details: details })
        get('/entry?id=' + encodeURIComponent(id))
          .then(function (out) {
            var next = Object.assign({}, ref.current.details || {})
            next[id] = out && out.entry ? out.entry : { error: '宿主没有返回该条记忆' }
            patch({ details: next })
          })
          .catch(function (e) {
            var next = Object.assign({}, ref.current.details || {})
            next[id] = { error: String((e && e.message) || e) }
            patch({ details: next })
          })
      }

      // 改容量：档位按钮与自定义输入走同一条写路由，返回体就是新的 stats。
      function resize(gb) {
        var target = Number(gb)
        if (!isFinite(target) || target <= 0) {
          patch({ error: '容量需为正数（GB）' })
          return
        }
        patch({ loading: true, error: '' })
        post('/resize', { gigabytes: target })
          .then(function (out) {
            patch({ loading: false, error: '', stats: out })
            setCap(String(out.maxGB))
          })
          .catch(function (e) {
            patch({ loading: false, error: String((e && e.message) || e) })
          })
      }

      function resetQuota() {
        patch({ loading: true, error: '' })
        post('/resize', { reset: true })
          .then(function (out) {
            patch({ loading: false, error: '', stats: out })
            setCap(String(out.maxGB))
          })
          .catch(function (e) {
            patch({ loading: false, error: String((e && e.message) || e) })
          })
      }

      react.useEffect(load, [])

      var stats = s.stats
      var pct = stats ? Math.max(0, Math.min(100, Number(stats.usedPercent) || 0)) : 0
      // 下面几个纯渲染辅助函数在 Panel 之外定义（客户端文件是单闭包，函数提升可用），
      // 所以把本轮的 state 与三个回调装成一个袋子传进去，避免它们直接摸 s/ref。
      var ui = { s: s, toggle: toggle, applyFilter: applyFilter, loadPage: loadPage }

      return h(
        'div',
        { style: { padding: '18px 20px', color: C.text, fontSize: 13, lineHeight: 1.6, maxWidth: 860 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '长期记忆库'),
          h('div', { style: { color: C.sub, fontSize: 12 } }, '跨会话持久记忆 · 只读面板'),
          h('div', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: load,
              disabled: ui.s.loading,
              style: {
                border: '1px solid ' + C.line,
                background: C.bg,
                color: C.text,
                borderRadius: 6,
                padding: '4px 10px',
                cursor: ui.s.loading ? 'default' : 'pointer',
                fontSize: 12,
              },
            },
            s.loading ? '读取中…' : '刷新'
          )
        ),

        s.error
          ? h(
              'div',
              { style: { border: '1px solid ' + C.danger, color: C.danger, borderRadius: 6, padding: '8px 10px', marginBottom: 12 } },
              '读取失败：' + s.error + '（多半是宿主半边的 /memory-vault 路由未挂上）'
            )
          : null,

        // 用量条
        h(
          'div',
          { style: { border: '1px solid ' + C.line, borderRadius: 8, padding: '12px 14px', marginBottom: 14, background: C.soft } },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.sub, marginBottom: 6 } },
            h('span', null, stats ? '已用 ' + fmtBytes(stats.bytes) + ' / ' + (stats.maxMB || 0) + ' MB' : '已用 —'),
            h('span', null, stats ? pct.toFixed(2) + '%' : '')
          ),
          h(
            'div',
            { style: { height: 8, borderRadius: 4, background: C.line, overflow: 'hidden' } },
            h('div', { style: { width: pct + '%', height: '100%', background: C.accent } })
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: C.sub } },
            h('span', null, '记录 ' + (stats ? stats.rows : '—') + ' 条'),
            h('span', null, '库文件 ' + (stats ? stats.dbPath : '—')),
            h('span', null, '最新 ' + (stats && stats.newest ? fmtTime(stats.newest) : '—'))
          )
        ),

        // 容量上限：常用档位 + 自定义
        h(
          'div',
          { style: { border: '1px solid ' + C.line, borderRadius: 8, padding: '10px 14px', marginBottom: 14 } },
          h(
            'div',
            { style: { fontSize: 12, color: C.sub, marginBottom: 8 } },
            '容量上限 ' + (stats ? stats.maxGB + ' GB' : '—') + (stats && stats.quotaSource === 'override' ? '（手动设定，重启不丢）' : '（来自配置）')
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            (stats && stats.presetsGB ? stats.presetsGB : [1, 5, 10, 20, 50]).map(function (gb) {
              var active = stats && Math.abs(Number(stats.maxGB) - gb) < 0.01
              return h(
                'button',
                {
                  key: 'preset-' + gb,
                  type: 'button',
                  onClick: function () {
                    resize(gb)
                  },
                  disabled: ui.s.loading,
                  style: {
                    border: '1px solid ' + (active ? C.accent : C.line),
                    background: active ? C.accent : C.bg,
                    color: active ? '#fff' : C.text,
                    borderRadius: 6,
                    padding: '5px 12px',
                    cursor: ui.s.loading ? 'default' : 'pointer',
                    fontSize: 12,
                  },
                },
                gb + ' GB'
              )
            }),
            h('span', { style: { width: 6 } }),
            h('input', {
              value: cap,
              placeholder: '自定义 GB',
              onChange: function (e) {
                setCap(e.target.value)
              },
              onKeyDown: function (e) {
                if (e.key === 'Enter') resize(cap)
              },
              style: {
                width: 100,
                border: '1px solid ' + C.line,
                borderRadius: 6,
                padding: '5px 8px',
                fontSize: 12,
                background: C.bg,
                color: C.text,
              },
            }),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  resize(cap)
                },
                disabled: ui.s.loading,
                style: {
                  border: '1px solid ' + C.line,
                  background: C.soft,
                  color: C.text,
                  borderRadius: 6,
                  padding: '5px 12px',
                  cursor: ui.s.loading ? 'default' : 'pointer',
                  fontSize: 12,
                },
              },
              '应用'
            ),
            stats && stats.quotaSource === 'override'
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: resetQuota,
                    disabled: ui.s.loading,
                    style: {
                      border: '1px solid ' + C.line,
                      background: 'transparent',
                      color: C.sub,
                      borderRadius: 6,
                      padding: '5px 10px',
                      cursor: ui.s.loading ? 'default' : 'pointer',
                      fontSize: 12,
                    },
                  },
                  '恢复配置值'
                )
              : null
          ),
          h(
            'div',
            { style: { fontSize: 11, color: C.sub, marginTop: 6 } },
            '可填 0.05~200 GB 之间的任意值。缩小容量会立刻淘汰超出的最旧记忆 —— 这是配额语义本身，不是 bug。'
          )
        ),

        // 检索
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginBottom: 12 } },
          h('input', {
            value: q,
            placeholder: '检索记忆（支持中文子串）',
            onChange: function (e) {
              setQ(e.target.value)
            },
            onKeyDown: function (e) {
              if (e.key === 'Enter') search()
            },
            style: {
              flex: 1,
              border: '1px solid ' + C.line,
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 13,
              background: C.bg,
              color: C.text,
            },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: search,
              style: { border: '1px solid ' + C.accent, background: C.accent, color: '#fff', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontSize: 13 },
            },
            '检索'
          )
        ),

        // 目录：按天 / 按会话切片，点一下只看那一组
        catalogBlock(ui, s.catalog),

        // 结果 / 最近
        s.results.length > 0 ? section(ui, '检索结果 ' + s.results.length + ' 条', s.results) : null,
        s.results.length === 0
          ? section(ui, listTitle(ui), s.recent, {
              more: s.recent.length < s.total,
              onMore: function () {
                loadPage(ui.s.recent.length, ui.s.filter)
              },
            })
          : null,

        // 页脚
        h(
          'div',
          { style: { marginTop: 16, paddingTop: 10, borderTop: '1px solid ' + C.line, color: C.sub, fontSize: 11 } },
          '数据来自宿主侧 ' + API + '/*。读接口只读；写接口只有两个：改容量上限（' + API + '/resize）与改本会话记忆模式（' + API + '/session-mode），都碰不到记忆内容。' +
            ' 列表只带摘要，点开卡片才按需取全文（' + API + '/entry）。' +
            (SEATS.main ? '' : ' 主面板座位未注册。') +
            (SEATS.error ? ' ' + SEATS.error : '')
        )
      )
    }

    function listTitle(ui) {
      var f = ui.s.filter || {}
      if (f.day) return '目录 · ' + f.day + '（' + ui.s.total + ' 条）'
      if (f.session) return '目录 · 会话 ' + String(f.session).slice(0, 12) + '（' + ui.s.total + ' 条）'
      return '最近写入 · 共 ' + (ui.s.total || ui.s.recent.length) + ' 条'
    }

    function chip(ui, key, label, active, onClick, title) {
      return h(
        'button',
        {
          key: key,
          type: 'button',
          title: title || label,
          onClick: onClick,
          disabled: ui.s.loading,
          style: {
            border: '1px solid ' + (active ? C.accent : C.line),
            background: active ? C.accent : C.bg,
            color: active ? '#fff' : C.text,
            borderRadius: 999,
            padding: '3px 10px',
            fontSize: 11,
            lineHeight: 1.5,
            cursor: ui.s.loading ? 'default' : 'pointer',
          },
        },
        label
      )
    }

    // 目录 = 索引，不是全文列表：条数多的时候先按天/按会话收窄，再点开具体一条
    function catalogBlock(ui, cat) {
      if (!cat) return null
      var days = cat.days || []
      var sessions = cat.sessions || []
      var f = ui.s.filter || {}
      var active = !!(f.day || f.session)
      if (days.length === 0 && sessions.length === 0) return null
      var dayChips = days.slice(0, 14).map(function (d) {
        return chip(ui,
          'day-' + d.day,
          d.day + ' · ' + d.count,
          f.day === d.day,
          function () {
            ui.applyFilter(f.day === d.day ? '' : d.day, '')
          },
          '只看这一天（' + fmtBytes(d.bytes) + '）'
        )
      })
      var sesChips =
        sessions.length > 1
          ? sessions.slice(0, 10).map(function (x) {
              var label = String(x.session || '').slice(0, 8) + ' · ' + x.count
              return chip(ui,
                'ses-' + x.session,
                label,
                f.session === x.session,
                function () {
                  ui.applyFilter('', f.session === x.session ? '' : x.session)
                },
                '只看这个会话（最近 ' + fmtTime(x.newest) + '）'
              )
            })
          : []
      return h(
        'div',
        { style: { border: '1px solid ' + C.line, borderRadius: 8, padding: '10px 14px', marginBottom: 14 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 } },
          h('span', { style: { fontSize: 12, color: C.sub } }, '目录 · ' + (cat.total || 0) + ' 条'),
          h('span', { style: { flex: 1 } }),
          active
            ? chip(
                ui,
                'clear',
                '取消筛选',
                false,
                function () {
                  ui.applyFilter('', '')
                },
                '回到全部记忆'
              )
            : null
        ),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: sessions.length > 1 ? 8 : 0 } }, dayChips),
        sessions.length > 1
          ? h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' } },
              h('span', { style: { fontSize: 11, color: C.sub, marginRight: 2 } }, '会话'),
              sesChips
            )
          : null
      )
    }

    function section(ui, title, rows, options) {
      var opts = options || {}
      return h(
        'div',
        { style: { marginBottom: 8 } },
        h('div', { style: { fontSize: 12, color: C.sub, margin: '0 0 6px' } }, title),
        rows.length === 0
          ? h('div', { style: { color: C.sub, fontSize: 12, padding: '8px 0' } }, '（空 —— 还没有任何记忆入库）')
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              rows.map(function (row, i) {
                return card(ui, row, i)
              })
            ),
        opts.more
          ? h(
              'button',
              {
                type: 'button',
                onClick: opts.onMore,
                disabled: ui.s.loading,
                style: {
                  marginTop: 8,
                  width: '100%',
                  border: '1px dashed ' + C.line,
                  background: 'transparent',
                  color: C.sub,
                  borderRadius: 8,
                  padding: '7px 10px',
                  fontSize: 12,
                  cursor: ui.s.loading ? 'default' : 'pointer',
                },
              },
              ui.s.loading ? '读取中…' : '加载更多（还有 ' + Math.max(0, (ui.s.total || 0) - rows.length) + ' 条）'
            )
          : null
      )
    }

    // 一张卡片 = 一个按钮：点一下展开全文（全文按需从 /entry 取，只取一次）
    function card(ui, row, i) {
      var id = row.id
      var open = !!(ui.s.expanded || {})[id]
      var detail = (ui.s.details || {})[id]
      var head = h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 } },
        h('span', { style: { fontSize: 13, fontWeight: 600, color: C.text } }, row.title || '（无标题）'),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { fontSize: 11, color: C.sub } }, fmtTime(row.ts) + ' · ' + (row.role || '?') + ' · ' + (row.chars || 0) + ' 字'),
        h('span', { style: { fontSize: 11, color: C.accent, marginLeft: 4 } }, open ? '收起' : '展开')
      )
      var bodyText = open && detail && detail.body !== undefined ? String(detail.body) : String(row.snippet || row.body || '')
      var meta = open ? detail : null
      return h(
        'div',
        {
          key: id || i,
          role: 'button',
          tabIndex: 0,
          title: open ? '点击收起' : '点击展开全文',
          onClick: function () {
            ui.toggle(row)
          },
          onKeyDown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              if (e.preventDefault) e.preventDefault()
              ui.toggle(row)
            }
          },
          style: {
            border: '1px solid ' + (open ? C.accent : C.line),
            borderRadius: 8,
            padding: '10px 12px',
            background: C.bg,
            cursor: 'pointer',
          },
        },
        head,
        open && detail && detail.loading
          ? h('div', { style: { fontSize: 12, color: C.sub } }, '读取全文…')
          : null,
        open && meta && meta.error
          ? h('div', { style: { fontSize: 12, color: C.danger } }, '读取失败：' + meta.error)
          : null,
        h(
          'div',
          {
            style: {
              fontSize: 12,
              color: C.text,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: open ? 320 : 72,
              overflow: open ? 'auto' : 'hidden',
              borderTop: open ? '1px dashed ' + C.line : 'none',
              paddingTop: open ? 6 : 0,
              marginTop: open ? 4 : 0,
            },
          },
          bodyText
        ),
        row.session
          ? h(
              'div',
              { style: { fontSize: 11, color: C.sub, marginTop: 4 } },
              '会话 ' + String(row.session).slice(0, 12) +
                (row.mode && row.mode !== 'long' ? ' · ' + (row.mode === 'multi' ? '本会话' : '单次') : '') +
                (meta && meta.hits !== undefined ? ' · 命中 ' + meta.hits + ' 次' : '') +
                (meta && meta.bytes ? ' · ' + fmtBytes(meta.bytes) : '')
            )
          : null
      )
    }

    // ── 输入区记忆模式选择器（conversation.input.left：紧挨「完全权限」的右侧）──
    // 只决定「这个会话之后的记忆怎么存」：long 永久 / multi 只在本会话 / once 召回一次即删。
    // 选择写进宿主（POST /session-mode），自动采集与 memory_save 的默认模式都跟着它走。
    var MODE_LABELS = { long: '长期', multi: '本会话', once: '单次' }
    var MODE_ORDER = ['long', 'multi', 'once']
    var MODE_HINTS = {
      long: '永久保存，任何会话都能召回',
      multi: '只在本会话可见，12 小时后清掉',
      once: '被召回一次就删除，不留痕',
    }

    function modeLabel(mode) {
      return MODE_LABELS[mode] || MODE_LABELS.long
    }

    function ModeChip(props) {
      var sessionId = ''
      try {
        var p = props || {}
        sessionId = String(p.sessionId || (p.session && p.session.id) || '')
      } catch (e) {
        sessionId = ''
      }
      var st = react.useState({ mode: 'long', open: false, error: '' })
      var s = st[0]
      var set = st[1]
      var ref = (react.useRef ? react.useRef(s) : null) || { current: s }
      ref.current = s
      function patch(extra) {
        var next = Object.assign({}, ref.current, extra || {})
        ref.current = next
        set(next)
      }

      // 首次挂载时问一次宿主：这个会话当前是什么模式（可能是上次选的）
      react.useEffect(
        function () {
          if (!sessionId) return
          get('/session-mode?session=' + encodeURIComponent(sessionId))
            .then(function (data) {
              patch({ mode: (data && data.mode) || 'long' })
            })
            .catch(function () {
              /* 读不到就按 long 显示，不打扰用户 */
            })
        },
        [sessionId]
      )

      function choose(mode) {
        if (!sessionId) {
          patch({ open: false, error: '会话未就绪' })
          return
        }
        patch({ error: '' })
        post('/session-mode', { session: sessionId, mode: mode })
          .then(function () {
            patch({ mode: mode, open: false })
          })
          .catch(function (e) {
            patch({ error: String((e && e.message) || e) })
          })
      }

      var btn = h(
        'button',
        {
          type: 'button',
          title: '本会话的记忆保存模式：' + modeLabel(s.mode) + '（点一下切换）',
          'aria-haspopup': 'listbox',
          'aria-expanded': s.open ? 'true' : 'false',
          onClick: function () {
            patch({ open: !ref.current.open })
          },
          style: {
            height: 24,
            padding: '0 8px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            lineHeight: '22px',
            color: s.mode === 'long' ? C.sub : C.accent,
            background: C.bg,
            border: '1px solid ' + C.line,
            borderRadius: 6,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        h('span', { key: 'k', style: { opacity: 0.65 } }, '记忆'),
        h('span', { key: 'v' }, modeLabel(s.mode)),
        h('span', { key: 'c', style: { fontSize: 9, opacity: 0.6 } }, '▾')
      )

      var popup = s.open
        ? h(
            'div',
            {
              role: 'listbox',
              style: {
                position: 'absolute',
                left: 0,
                bottom: 30,
                zIndex: 40,
                minWidth: 196,
                padding: 4,
                background: C.bg,
                border: '1px solid ' + C.line,
                borderRadius: 8,
                boxShadow: '0 6px 18px rgba(0,0,0,0.16)',
              },
            },
            MODE_ORDER.map(function (mode) {
              var active = mode === s.mode
              return h(
                'button',
                {
                  key: mode,
                  type: 'button',
                  role: 'option',
                  'aria-selected': active ? 'true' : 'false',
                  onClick: function () {
                    choose(mode)
                  },
                  style: {
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    border: 'none',
                    borderRadius: 6,
                    background: active ? C.soft : 'transparent',
                    color: active ? C.accent : C.text,
                    cursor: 'pointer',
                  },
                },
                h('div', { key: 't', style: { fontSize: 12, fontWeight: active ? 600 : 400 } }, modeLabel(mode)),
                h('div', { key: 'h', style: { fontSize: 11, color: C.sub, marginTop: 2 } }, MODE_HINTS[mode])
              )
            }),
            s.error
              ? h('div', { key: 'err', style: { fontSize: 11, color: C.danger, padding: '4px 8px' } }, s.error)
              : null
          )
        : null

      return h('span', { style: { position: 'relative', display: 'inline-flex' } }, btn, popup)
    }

    // ── 装配 ──
    function apply(ctx) {
      try {
        ctx.inject(['slots'], function (scope) {
          try {
            scope.slots.inject('sidebar.panellist', function () {
              return scope.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 72, label: function () { return '长期记忆' } },
                function (props) {
                  return h(PanelIcon, props)
                }
              )
            })
            SEATS.icon = true
          } catch (e) {
            SEATS.error = '侧栏图标注册失败：' + ((e && e.message) || e)
          }
          try {
            scope.slots.inject('conversation.input.left', function () {
              return scope.slots.register({ name: 'conversation.input.left', id: PANEL_ID + '-mode', order: 10 }, function (props) {
                return h(ModeChip, props)
              })
            })
            SEATS.mode = true
          } catch (e) {
            SEATS.error = (SEATS.error ? SEATS.error + '；' : '') + '记忆模式选择器注册失败：' + ((e && e.message) || e)
          }
          try {
            scope.slots.inject('main', function () {
              return scope.slots.register({ name: 'main', key: PANEL_ID }, function (props) {
                return h(Panel, Object.assign({}, props, { ctx: scope }))
              })
            })
            SEATS.main = true
          } catch (e) {
            SEATS.error = (SEATS.error ? SEATS.error + '；' : '') + '主面板注册失败：' + ((e && e.message) || e)
          }
        })
      } catch (e) {
        SEATS.error = 'slots 服务不可用：' + ((e && e.message) || e)
      }
    }

    exports.name = 'dsh-memory-vault'
    exports.apply = apply
    exports.inject = []
    exports.__panel = { Panel: Panel, PanelIcon: PanelIcon, ModeChip: ModeChip, SEATS: SEATS, PANEL_ID: PANEL_ID, API: API }
    return module.exports
  },
})