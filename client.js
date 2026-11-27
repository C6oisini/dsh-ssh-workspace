// Client half of dsh-ssh-workspace.
//
// The entry point is a main panel in the left rail ("SSH 远程工作区", next to
// Plugins / Tasks): it lists ~/.ssh/config hosts, browses remote directories,
// and turns a chosen directory into a native workspace whose local path is a
// sentinel folder. Creating a session from there runs the agent over SSH.
//
// Nothing here touches the native directory-flow slots: dsh-remote already
// owns those in this profile, and two occupants would fight.

window.__ModuleLoader__.load({
  id: 'dsh-ssh-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sshWorkspace'
    const PANEL_ID = 'ssh-workspace'

    const L = {
      zh: {
        panel: 'SSH 远程工作区',
        title: 'SSH 远程工作区',
        subtitle: '用服务器的文件夹作为工作区：选择主机和目录，新建会话后 Agent 直接在远端读写和执行命令。',
        hosts: 'SSH 主机',
        noHosts: '~/.ssh/config 里没有可用主机。添加 Host 后刷新。',
        workspaces: '远程工作区',
        noWorkspaces: '还没有远程工作区。选一个主机和目录开始。',
        refresh: '刷新',
        browse: '浏览目录',
        pathPlaceholder: '输入绝对路径，回车跳转',
        up: '上级',
        open: '打开为工作区',
        opening: '正在创建…',
        back: '返回主机',
        newSession: '新会话',
        remove: '移除',
        emptyDir: '空目录',
        loading: '加载中…',
        localPlaceholder: '本地占位目录',
        hostLabel: '主机',
        dirLabel: '目录',
        error: '出错了',
      },
      en: {
        panel: 'SSH Workspace',
        title: 'SSH remote workspaces',
        subtitle: 'Use a folder on an SSH host as the workspace: pick a host and directory, then the agent reads, edits and runs commands remotely.',
        hosts: 'SSH hosts',
        noHosts: 'No hosts in ~/.ssh/config. Add a Host entry and refresh.',
        workspaces: 'Remote workspaces',
        noWorkspaces: 'No remote workspace yet. Pick a host and a directory to start.',
        refresh: 'Refresh',
        browse: 'Browse',
        pathPlaceholder: 'Type an absolute path, press Enter',
        up: 'Up',
        open: 'Open as workspace',
        opening: 'Creating…',
        back: 'Back to hosts',
        newSession: 'New session',
        remove: 'Remove',
        emptyDir: 'empty directory',
        loading: 'Loading…',
        localPlaceholder: 'local placeholder',
        hostLabel: 'Host',
        dirLabel: 'Directory',
        error: 'Error',
      },
    }

    const token = (name, fallback) => `var(--dsw-alias-${name}, ${fallback})`

    const styles = {
      page: {
        height: '100%',
        overflow: 'auto',
        padding: '28px 32px 48px',
        color: token('label-primary', '#1f2328'),
        fontSize: 14,
        lineHeight: 1.5,
      },
      header: { maxWidth: 880, margin: '0 auto 22px' },
      title: { fontSize: 20, fontWeight: 600, margin: '0 0 6px' },
      subtitle: { margin: 0, color: token('label-secondary', '#6b7280'), fontSize: 13 },
      card: {
        maxWidth: 880,
        margin: '0 auto 18px',
        border: `1px solid ${token('border-l1', '#e5e7eb')}`,
        borderRadius: 10,
        background: token('bg-l1', 'transparent'),
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        borderBottom: `1px solid ${token('border-l1', '#e5e7eb')}`,
        fontSize: 12, fontWeight: 600, letterSpacing: '0.02em',
        color: token('label-secondary', '#6b7280'),
      },
      row: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 14px',
        borderTop: `1px solid ${token('border-l1', '#e5e7eb')}`,
        cursor: 'default',
      },
      rowButton: { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 },
      mute: { color: token('label-secondary', '#6b7280'), fontSize: 12.5 },
      btn: {
        all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 6,
        border: `1px solid ${token('border-l2', '#d1d5db')}`,
        fontSize: 12.5, whiteSpace: 'nowrap',
        background: token('bg-l2', 'transparent'),
      },
      btnPrimary: {
        all: 'unset', cursor: 'pointer', padding: '5px 12px', borderRadius: 6,
        background: token('brand-primary', '#2563eb'),
        color: token('brand-text', '#fff'),
        fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap',
      },
      pathBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: `1px solid ${token('border-l1', '#e5e7eb')}` },
      pathText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pathInput: {
        flex: 1, minWidth: 0, boxSizing: 'border-box',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12.5, lineHeight: '20px', padding: '5px 10px', borderRadius: 8,
        color: token('label-primary', '#111827'),
        background: token('bg-l2', 'rgba(127,127,127,0.08)'),
        border: `1px solid ${token('border-l1', '#e5e7eb')}`,
        outline: 'none',
      },
      error: { color: token('state-error-primary', '#b91c1c'), fontSize: 12.5, padding: '8px 14px' },
      loading: { padding: '18px 14px', color: token('label-secondary', '#6b7280'), fontSize: 12.5 },
      badge: {
        fontSize: 11, padding: '1px 6px', borderRadius: 999,
        border: `1px solid ${token('border-l1', '#e5e7eb')}`,
        color: token('label-secondary', '#6b7280'),
      },
      toolCard: {
        border: `1px solid ${token('border-l1', '#e5e7eb')}`,
        borderRadius: 8,
        overflow: 'hidden',
      },
      toolBody: {
        display: 'grid', gap: 6,
        padding: '8px 10px',
        borderTop: `1px solid ${token('border-l1', '#e5e7eb')}`,
      },
      toolPre: {
        margin: 0, padding: 0, maxHeight: 320, overflow: 'auto',
        whiteSpace: 'pre-wrap', lineHeight: 1.45, fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      toolCmd: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      toolCmdFull: {
        margin: 0, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap',
        wordBreak: 'break-all', lineHeight: 1.45, fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
    }

    function apiPath(path) {
      if (window.location && window.location.protocol === 'dsh-app:') return '/api' + path
      const base = typeof document !== 'undefined' ? document.baseURI : ''
      if (!base) return path
      try {
        const baseUrl = new URL(base)
        if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') return path
        return new URL('.', baseUrl).pathname + path.replace(/^\/+/, '')
      } catch {
        return path
      }
    }

    async function request(path, init) {
      const response = await fetch(apiPath(path), Object.assign({
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }, init || {}))
      let body = null
      try {
        body = await response.json()
      } catch {
        // Non-JSON errors (proxy HTML) surface through the status below.
      }
      if (!response.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `HTTP ${response.status}`)
      }
      return body
    }

    const api = {
      hosts: () => request('/dsh-ssh/hosts'),
      workspaces: () => request('/dsh-ssh/workspaces'),
      ping: (alias) => request(`/dsh-ssh/ping?alias=${encodeURIComponent(alias)}`),
      ls: (alias, path) => request(`/dsh-ssh/ls?alias=${encodeURIComponent(alias)}${path ? `&path=${encodeURIComponent(path)}` : ''}`),
      bind: (alias, remotePath) => request('/dsh-ssh/bind', { method: 'POST', body: JSON.stringify({ alias, remotePath }) }),
      forget: (localPath) => request('/dsh-ssh/forget', { method: 'POST', body: JSON.stringify({ localPath }) }),
    }

    function hostLabel(host) {
      if (!host) return ''
      const who = host.user ? `${host.user}@${host.hostname}` : host.hostname
      return host.port && host.port !== 22 ? `${who}:${host.port}` : who
    }

    function parentOf(p) {
      if (!p || p === '/') return null
      const trimmed = p.replace(/\/+$/, '')
      const index = trimmed.lastIndexOf('/')
      return index <= 0 ? '/' : trimmed.slice(0, index)
    }

    function Row(props) {
      return h('div', { style: styles.row }, props.children)
    }

    function HostsCard(props) {
      const { t, hosts, onBrowse, browsing } = props
      return h('div', { style: styles.card },
        h('div', { style: styles.cardHead }, h('span', null, t('hosts')), h('span', { style: styles.badge }, String(hosts.length))),
        hosts.length === 0
          ? h('div', { style: styles.loading }, t('noHosts'))
          : hosts.map((host) => h(Row, { key: host.alias },
              h('button', {
                type: 'button',
                style: styles.rowButton,
                disabled: browsing,
                onClick: () => onBrowse(host.alias, null),
              },
                h('span', { style: { fontWeight: 550 } }, host.alias),
                h('span', { style: styles.mute }, hostLabel(host)),
              ),
              h('span', { style: styles.mute }, host.workspaces ? `${host.workspaces} ws` : ''),
              h('button', { type: 'button', style: styles.btn, disabled: browsing, onClick: () => onBrowse(host.alias, null) }, t('browse')),
            )),
      )
    }

    function BrowseCard(props) {
      const { t, state, onUp, onOpen, onRefresh, onBack, onNavigate } = props
      const parent = parentOf(state.path)
      // The path bar doubles as an address bar: type any absolute path (or
      // nothing for $HOME) and press Enter to jump there.
      const [draft, setDraft] = React.useState(state.path || '')
      React.useEffect(() => { setDraft(state.path || '') }, [state.path])
      const submit = () => {
        const next = draft.trim()
        if (next === (state.path || '')) return
        onNavigate(state.alias, next)
      }
      return h('div', { style: styles.card },
        h('div', { style: styles.cardHead },
          h('span', null, `${t('hostLabel')}: ${state.alias}`),
          h('button', { type: 'button', style: Object.assign({}, styles.btn, { marginLeft: 'auto' }), onClick: onBack }, t('back')),
        ),
        h('div', { style: styles.pathBar },
          h('button', { type: 'button', style: styles.btn, disabled: !parent || state.busy, onClick: onUp }, t('up')),
          h('input', {
            type: 'text',
            value: draft,
            spellCheck: false,
            autoComplete: 'off',
            style: styles.pathInput,
            placeholder: t('pathPlaceholder'),
            onChange: (event) => setDraft(event.target.value),
            onFocus: (event) => event.currentTarget.select(),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); submit() }
              else if (event.key === 'Escape') { setDraft(state.path || ''); event.currentTarget.blur() }
            },
          }),
          h('button', { type: 'button', style: styles.btn, disabled: state.busy, onClick: onRefresh }, t('refresh')),
          h('button', { type: 'button', style: Object.assign({}, styles.btnPrimary, state.busy ? { opacity: 0.6 } : null), disabled: state.busy || !state.path, onClick: onOpen },
            state.busy ? t('opening') : t('open')),
        ),
        state.error ? h('div', { style: styles.error }, `${t('error')}: ${state.error}`) : null,
        state.loading
          ? h('div', { style: styles.loading }, t('loading'))
          : (state.entries.length === 0
              ? h('div', { style: styles.loading }, t('emptyDir'))
              : state.entries.map((entry) => h(Row, { key: entry.name },
                  entry.type === 'directory'
                    ? h('button', { type: 'button', style: styles.rowButton, onClick: () => props.onEnter(entry.name) },
                        h('span', {style:{color: token('label-secondary','#6b7280')}}, 'dir'),
                        h('span', { style: styles.mono }, entry.name),
                      )
                    : h('div', { style: styles.rowButton },
                        h('span', {style:{color: token('label-secondary','#6b7280')}}, 'file'),
                        h('span', { style: Object.assign({}, styles.mono, { color: token('label-secondary', '#6b7280') }) }, entry.name),
                        h('span', { style: Object.assign({}, styles.mute, { marginLeft: 'auto' }) }, `${entry.size} B`),
                      ),
                ))),
      )
    }

    function WorkspacesCard(props) {
      const { t, workspaces, onSession, onRemove, busy } = props
      return h('div', { style: styles.card },
        h('div', { style: styles.cardHead }, h('span', null, t('workspaces')), h('span', { style: styles.badge }, String(workspaces.length))),
        workspaces.length === 0
          ? h('div', { style: styles.loading }, t('noWorkspaces'))
          : workspaces.map((workspace) => h(Row, { key: workspace.localPath },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: styles.mono }, `${workspace.alias}:${workspace.remotePath}`),
                h('div', { style: styles.mute }, workspace.localPath),
              ),
              h('button', { type: 'button', style: styles.btnPrimary, disabled: busy, onClick: () => onSession(workspace) }, t('newSession')),
              h('button', { type: 'button', style: styles.btn, disabled: busy, onClick: () => onRemove(workspace) }, t('remove')),
            )),
      )
    }

    function PanelPage(props) {
      const t = props.t
      const [hosts, setHosts] = React.useState([])
      const [workspaces, setWorkspaces] = React.useState([])
      const [browse, setBrowse] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const [hostsResult, workspacesResult] = await Promise.all([api.hosts(), api.workspaces()])
          setHosts(hostsResult.hosts || [])
          setWorkspaces(workspacesResult.workspaces || [])
          setError('')
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      const navigate = React.useCallback(async (alias, path) => {
        setBusy(true)
        setError('')
        try {
          const result = await api.ls(alias, path)
          setBrowse({ alias, path: result.path, entries: result.entries || [], loading: false, busy: false, error: '' })
        } catch (cause) {
          const message = String((cause && cause.message) || cause)
          setBrowse((current) => ({ alias, path: (current && current.path) || path || '', entries: (current && current.entries) || [], loading: false, busy: false, error: message }))
        } finally {
          setBusy(false)
        }
      }, [])

      const open = React.useCallback(async (alias, remotePath) => {
        setBusy(true)
        setError('')
        try {
          const result = await api.bind(alias, remotePath)
          await props.openWorkspace(result.binding.localPath)
          await refresh()
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setBusy(false)
        }
      }, [props, refresh])

      const remove = React.useCallback(async (workspace) => {
        setBusy(true)
        try {
          await api.forget(workspace.localPath)
          await refresh()
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setBusy(false)
        }
      }, [refresh])

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('h1', { style: styles.title }, t('title')),
          h('p', { style: styles.subtitle }, t('subtitle')),
        ),
        error ? h('div', { style: Object.assign({}, styles.card, { padding: '10px 14px', color: token('state-error-primary', '#b91c1c') }) }, `${t('error')}: ${error}`) : null,
        browse
          ? h(BrowseCard, {
              t,
              state: Object.assign({}, browse, { busy }),
              onUp: () => navigate(browse.alias, parentOf(browse.path) || '/'),
              onEnter: (name) => navigate(browse.alias, browse.path === '/' ? `/${name}` : `${browse.path}/${name}`),
              onRefresh: () => navigate(browse.alias, browse.path),
              onNavigate: (alias, nextPath) => navigate(alias, nextPath),
              onBack: () => { setBrowse(null); void refresh() },
              onOpen: () => open(browse.alias, browse.path),
            })
          : h(HostsCard, { t, hosts, browsing: busy, onBrowse: (alias, path) => navigate(alias, path) }),
        h(WorkspacesCard, {
          t, workspaces, busy,
          onSession: (workspace) => { void props.openWorkspace(workspace.localPath) },
          onRemove: (workspace) => { void remove(workspace) },
        }),
      )
    }

    function PanelIcon(props) {
      const size = props.size || 18
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 3, y: 13, width: 18, height: 7, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 7, cy: 7.5, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 7, cy: 16.5, r: 1, fill: 'currentColor' }),
      )
    }

    // Tool cards receive the settled result as `props.block`; presentationMeta
    // from the Host side lands on `block.meta`, not on the props root.
    function resultMeta(props) {
      const block = props.block || {}
      return block.meta && typeof block.meta === 'object' ? block.meta : {}
    }

    function resultText(props) {
      const blocks = (props.block && props.block.content) || []
      return blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }

    function resultError(props) {
      const error = props.block && props.block.error
      if (!error) return ''
      return [error.name, error.code, error.reason].filter(Boolean).join(' · ')
    }

    function diffLines(diff) {
      const lines = String(diff || '').split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines.slice(0, 240)
    }

    function CardChevron(props) {
      return h('span', {
        style: {
          width: 12, display: 'inline-flex', justifyContent: 'center',
          color: token('label-secondary', '#6b7280'), fontSize: 10,
        },
        'aria-hidden': true,
      }, props.open ? '▼' : '▶')
    }

    function cardHeader(open, onToggle, children, disabled) {
      return h('button', {
        type: 'button',
        onClick: disabled ? undefined : onToggle,
        disabled: Boolean(disabled),
        'aria-expanded': Boolean(open),
        title: disabled ? 'running' : open ? 'collapse' : 'expand',
        style: {
          all: 'unset', boxSizing: 'border-box', display: 'flex', gap: 8,
          alignItems: 'center', width: '100%', padding: '7px 10px',
          cursor: disabled ? 'default' : 'pointer',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12, color: token('label-primary', '#111827'),
        },
      }, h(CardChevron, { open: Boolean(open) }), children)
    }

    function toolArgs(props) {
      try {
        const raw = props.block && (props.block.argsRaw || (props.block.call && props.block.call.argsRaw))
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    }

    function DiffCard(props) {
      const [open, setOpen] = React.useState(false)
      const meta = resultMeta(props)
      const args = toolArgs(props)

      if (props.phase !== 'result') {
        return h('div', { style: styles.toolCard },
          cardHeader(false, null, [
            h('span', { style: styles.badge }, props.toolName),
            h('span', { style: styles.toolCmd }, args.path || ''),
            h('span', { style: styles.mute }, 'running…'),
          ], true),
        )
      }

      const isError = Boolean(props.block && props.block.isError)
      const red = token('state-error-primary', '#b91c1c')
      const lines = diffLines(meta.diff)
      return h('div', {
        style: Object.assign({}, styles.toolCard, {
          border: `1px solid ${isError ? red : token('border-l1', '#e5e7eb')}`,
        }),
      },
        cardHeader(open, () => setOpen((value) => !value), [
          h('span', { style: styles.badge }, props.toolName),
          h('span', { style: styles.toolCmd }, args.path || ''),
          isError
            ? h('span', { style: { color: red } }, 'failed')
            : h('span', { style: { display: 'flex', gap: 6 } },
              h('span', { style: { color: token('state-success-primary', '#15803d') } }, `+${meta.added || 0}`),
              h('span', { style: { color: red } }, `-${meta.removed || 0}`),
            ),
        ]),
        open ? h('div', { style: styles.toolBody },
          args.path ? h('div', { style: Object.assign({}, styles.mute, { wordBreak: 'break-all' }) }, args.path) : null,
          isError
            ? h('pre', { style: styles.toolPre }, resultError(props) || resultText(props))
            : (lines.length
              ? h('pre', { style: styles.toolPre },
                lines.map((line, index) => h('div', {
                  key: index,
                  style: {
                    whiteSpace: 'pre-wrap',
                    color: line.startsWith('+') && !line.startsWith('+++') ? token('state-success-primary', '#15803d')
                      : line.startsWith('-') && !line.startsWith('---') ? red
                        : token('label-secondary', '#6b7280'),
                    background: line.startsWith('+') && !line.startsWith('+++') ? token('file-diff-added-bg', 'transparent')
                      : line.startsWith('-') && !line.startsWith('---') ? token('file-diff-deleted-bg', 'transparent')
                        : 'transparent',
                  },
                }, line || ' ')))
              : h('div', { style: styles.mute }, 'no changes')),
        ) : null,
      )
    }

    function ExecCard(props) {
      const [open, setOpen] = React.useState(false)
      const meta = resultMeta(props)
      const args = toolArgs(props)
      const command = args.command || ''

      if (props.phase !== 'result') {
        return h('div', { style: styles.toolCard },
          cardHeader(false, null, [
            h('span', { style: styles.badge }, 'ssh'),
            h('span', { style: styles.toolCmd }, `$ ${command}`),
            h('span', { style: styles.mute }, 'running…'),
          ], true),
        )
      }

      const output = resultText(props).replace(/\n+$/, '')
      const isError = Boolean(props.block && props.block.isError)
      const hasCode = meta.code !== undefined && meta.code !== null
      const failed = isError || (hasCode && Number(meta.code) !== 0)
      const red = token('state-error-primary', '#b91c1c')
      const status = isError ? 'failed' : hasCode ? `exit ${meta.code}` : meta.timedOut ? 'timeout' : 'done'
      const facts = [meta.cwd, hasCode ? `${meta.durationMs || 0} ms` : ''].filter(Boolean).join(' · ')

      return h('div', {
        style: Object.assign({}, styles.toolCard, {
          border: `1px solid ${failed ? red : token('border-l1', '#e5e7eb')}`,
        }),
      },
        cardHeader(open, () => setOpen((value) => !value), [
          h('span', { style: styles.badge }, meta.host || 'ssh'),
          h('span', { style: styles.toolCmd }, `$ ${command}`),
          h('span', { style: { flexShrink: 0, color: failed ? red : token('state-success-primary', '#15803d') } }, status),
        ]),
        open ? h('div', { style: styles.toolBody },
          h('pre', { style: styles.toolCmdFull }, `$ ${command}`),
          facts ? h('div', { style: styles.mute }, facts) : null,
          output
            ? h('pre', { style: Object.assign({}, styles.toolPre, { color: failed ? red : undefined }) }, output)
            : h('div', { style: styles.mute }, isError ? (resultError(props) || 'no output') : 'no output'),
        ) : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'layout', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        let tr = (key) => key
        ctx.effect(() => {
          const locale = ctx.get('locale')
          if (!locale || typeof locale.register !== 'function') return () => {}
          const dispose = locale.register(NS, L)
          const bound = locale.bind(NS)
          tr = (key) => {
            const text = bound(key)
            return text === key ? key : text
          }
          return () => { dispose?.() }
        }, 'dsh-ssh-workspace.locale')

        const openWorkspace = async (localPath) => {
          const workspaces = ctx.get('workspaces')
          const ui = ctx.get('uiWorkspace')
          const created = await workspaces.create({ path: localPath })
          const id = (created && (created.id || (created.workspace && created.workspace.id))) || localPath
          if (ui && typeof ui.startSession === 'function') await ui.startSession(id)
          const layout = ctx.get('layout')
          // null = back to the current conversation (the panel we came from is
          // this plugin's own main panel).
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => tr('panel'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t: tr, openWorkspace }),
        }, PanelPage))

        for (const toolName of ['ssh_write', 'ssh_edit']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolName,
          }, DiffCard))
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'ssh_bash',
        }, ExecCard))
      },
    }
  },
})
