window.__ModuleLoader__.load({
  id: '@local/dotnet-runner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ENDPOINT = '/dotnet-runner'

    // The floating control lives on the root overlay, which knows no Session.
    // A renderless entry inside the composer dock publishes the Session the
    // control belongs to, and the Host resolves that Session's working
    // directory as the current workspace.
    const sessionState = { id: null, listeners: new Set() }

    function subscribeSession(listener) {
      sessionState.listeners.add(listener)
      return () => sessionState.listeners.delete(listener)
    }

    function getSessionSnapshot() {
      return sessionState.id
    }

    function publishSession(id) {
      if (sessionState.id === id) return
      sessionState.id = id
      for (const listener of sessionState.listeners) listener()
    }

    function useSessionId() {
      return React.useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot)
    }

    function SessionBridge({ sessionId }) {
      React.useEffect(() => {
        publishSession(sessionId)
      }, [sessionId])
      return null
    }

    const SVG = { viewBox: '0 0 24 24', 'aria-hidden': true }
    const STROKE = {
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }

    function PlayIcon() {
      return h('svg', { ...SVG, width: 20, height: 20 }, h('path', { d: 'M8 5.4 19 12 8 18.6Z', fill: 'currentColor' }))
    }

    function RerunIcon() {
      return h(
        'svg',
        { ...SVG, width: 20, height: 20, ...STROKE },
        h('polyline', { points: '22 4 22 10 16 10' }),
        h('path', { d: 'M20.2 15a8.6 8.6 0 1 1-1.8-9.3L22 10' }),
        h('path', { d: 'M10.5 9.2 14.7 12l-4.2 2.8Z', fill: 'currentColor', stroke: 'none' }),
      )
    }

    function StopIcon() {
      return h(
        'svg',
        { ...SVG, width: 20, height: 20 },
        h('rect', { x: 5, y: 5, width: 14, height: 14, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 2.4 }),
      )
    }

    function SpinnerIcon() {
      return h(
        'svg',
        { ...SVG, width: 20, height: 20, className: 'dsdr-spin', ...STROKE },
        h('path', { d: 'M12 3.5a8.5 8.5 0 1 1-6 2.5' }),
      )
    }

    function MoreIcon() {
      return h(
        'svg',
        { ...SVG, width: 20, height: 20, fill: 'currentColor' },
        h('circle', { cx: 5, cy: 12, r: 1.8 }),
        h('circle', { cx: 12, cy: 12, r: 1.8 }),
        h('circle', { cx: 19, cy: 12, r: 1.8 }),
      )
    }

    const STYLE = `
      .dsdr {
        position: fixed;
        right: 20px;
        bottom: 132px;
        z-index: 30;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 40px;
        pointer-events: auto;
      }
      .dsdr-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        padding: 0;
        border: 0;
        border-radius: 10px;
        color: #fff;
        cursor: pointer;
        transition: filter 120ms ease, opacity 120ms ease;
      }
      .dsdr-btn:hover:not(:disabled) { filter: brightness(1.08); }
      .dsdr-btn:active:not(:disabled) { filter: brightness(0.92); }
      .dsdr-btn:disabled { opacity: 0.42; cursor: default; }
      .dsdr-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dsdr-run { background: var(--dsw-alias-state-success-primary); }
      .dsdr-stop { background: var(--dsw-alias-state-error-primary); }
      .dsdr-more {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
      }
      .dsdr-more:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .dsdr-dot {
        position: absolute;
        top: -2px;
        right: -2px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--dsw-alias-state-error-primary);
        box-shadow: 0 0 0 2px var(--dsw-alias-bg-base);
      }
      .dsdr-spin { animation: dsdr-spin 0.9s linear infinite; }
      @keyframes dsdr-spin { to { transform: rotate(360deg); } }
      .dsdr-pop {
        position: absolute;
        right: calc(100% + 10px);
        bottom: 0;
        display: flex;
        flex-direction: column;
        gap: 9px;
        width: 300px;
        padding: 11px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px;
        background: var(--dsw-alias-bg-overlay);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
        color: var(--dsw-alias-label-primary);
        font: 12.5px/1.45 ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
      }
      .dsdr-head { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dsdr-head-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dsdr-refresh { margin-left: auto; padding: 0 2px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
      .dsdr-refresh:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
      .dsdr-refresh:disabled { opacity: 0.5; cursor: default; }
      .dsdr-path { overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dsdr-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dsdr-select {
        width: 100%;
        height: 32px;
        padding: 0 8px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        cursor: pointer;
      }
      .dsdr-select:disabled { opacity: 0.6; cursor: default; }
      .dsdr-status { overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dsdr-status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
      .dsdr-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
      .dsdr-cmd {
        overflow-wrap: anywhere;
        color: var(--dsw-alias-label-secondary);
        font: 10.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .dsdr-log {
        margin: 0;
        max-height: 200px;
        overflow: auto;
        padding: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      @media (max-width: 720px) { .dsdr { right: 12px; bottom: 120px; } }
    `

    async function request(pathname, body) {
      const options = body === undefined
        ? { method: 'GET', cache: 'no-store' }
        : {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
      const response = await fetch(ENDPOINT + pathname, options)
      const data = await response.json().catch(() => null)
      if (!data || data.ok !== true) {
        throw new Error((data && data.error) || `请求失败（HTTP ${response.status}）`)
      }
      return data
    }

    function messageOf(failure) {
      if (failure instanceof Error && failure.message) return failure.message
      return String(failure)
    }

    function rootNameOf(path) {
      return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path)
    }

    function Runner() {
      const sessionId = useSessionId()
      const [projects, setProjects] = React.useState([])
      const [selected, setSelected] = React.useState('')
      const [root, setRoot] = React.useState('')
      const [state, setState] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [output, setOutput] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const logRef = React.useRef(null)

      const detect = React.useCallback(async () => {
        if (!sessionId) return
        setLoading(true)
        setError('')
        try {
          const data = await request(`/projects?session=${encodeURIComponent(sessionId)}`)
          const list = data.projects || []
          setProjects(list)
          setRoot(data.root || '')
          setState(data.state || null)
          setSelected((current) => {
            if (current && list.some((item) => item.path === current)) return current
            return list.length > 0 ? list[0].path : ''
          })
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setLoading(false)
        }
      }, [sessionId])

      React.useEffect(() => {
        if (sessionId) detect()
      }, [detect, sessionId])

      const phase = state ? state.phase : 'idle'
      const building = phase === 'building'
      const active = phase === 'running' || phase === 'starting'

      React.useEffect(() => {
        if (phase !== 'running' && phase !== 'starting' && phase !== 'building') return undefined
        let cancelled = false
        const timer = setInterval(() => {
          const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
          request(`/status${query}`)
            .then((data) => {
              if (cancelled) return
              setState(data.state || null)
              setOutput(data.output || '')
            })
            .catch((failure) => {
              if (!cancelled) setError(messageOf(failure))
            })
        }, 900)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [phase, sessionId])

      React.useEffect(() => {
        const element = logRef.current
        if (open && element) element.scrollTop = element.scrollHeight
      }, [open, output])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const run = async () => {
        if (!selected) return
        setBusy(true)
        setError('')
        setOpen(false)
        setOutput('')
        try {
          const data = await request('/start', { sessionId, path: selected })
          setState(data.state || null)
        } catch (failure) {
          setError(messageOf(failure))
          setOpen(true)
        } finally {
          setBusy(false)
        }
      }

      const stop = async () => {
        setBusy(true)
        setError('')
        try {
          const data = await request('/stop', {})
          setState(data.state || null)
        } catch (failure) {
          setError(messageOf(failure))
          setOpen(true)
        } finally {
          setBusy(false)
        }
      }

      const canRun = Boolean(selected) && Boolean(sessionId) && !busy && !building && phase !== 'starting'
      const canStop = phase === 'running' && !busy
      const runTitle = building ? '正在编译' : active ? '重新运行' : '开始'

      let statusText = ''
      let statusTone = ''
      if (error) {
        statusText = error
        statusTone = 'error'
      } else if (!sessionId) {
        statusText = '正在定位工作区…'
      } else if (loading) {
        statusText = '正在检测工作区…'
      } else if (projects.length === 0) {
        statusText = '未检测到 .NET 项目（.csproj）'
      } else if (building) {
        statusText = `编译中 · ${state.projectName || ''}`
      } else if (phase === 'starting') {
        statusText = '正在启动…'
      } else if (phase === 'running') {
        statusText = `运行中 · ${state.projectName || ''}`
        statusTone = 'ok'
      } else if (phase === 'failed') {
        statusText = state.message || '运行失败'
        statusTone = 'error'
      } else if (phase === 'exited') {
        statusText = state.message || '运行结束'
      } else if (phase === 'idle' && state && state.message) {
        statusText = state.message
      } else {
        statusText = `${projects.length} 个项目`
      }
      if (state && state.lastLine && phase !== 'idle' && phase !== 'running') {
        statusText += ` · ${state.lastLine}`
      }

      return h(
        'div',
        { className: 'dsdr', ref: rootRef },
        h('style', null, STYLE),
        h(
          'button',
          {
            className: 'dsdr-btn dsdr-run',
            type: 'button',
            title: runTitle,
            'aria-label': runTitle,
            disabled: !canRun,
            onClick: run,
          },
          building ? h(SpinnerIcon) : active ? h(RerunIcon) : h(PlayIcon),
        ),
        h(
          'button',
          {
            className: 'dsdr-btn dsdr-stop',
            type: 'button',
            title: '停止',
            'aria-label': '停止',
            disabled: !canStop,
            onClick: stop,
          },
          h(StopIcon),
        ),
        h(
          'button',
          {
            className: 'dsdr-btn dsdr-more',
            type: 'button',
            title: '更多',
            'aria-label': '更多',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h(MoreIcon),
          error ? h('span', { className: 'dsdr-dot' }) : null,
        ),
        open
          ? h(
              'div',
              { className: 'dsdr-pop' },
              h(
                'div',
                { className: 'dsdr-head' },
                h('span', { className: 'dsdr-head-name', title: root || undefined }, rootNameOf(root) || '当前工作区'),
                h(
                  'button',
                  {
                    className: 'dsdr-refresh',
                    type: 'button',
                    title: '重新检测项目',
                    'aria-label': '重新检测项目',
                    disabled: !sessionId || loading || busy,
                    onClick: detect,
                  },
                  '⟳',
                ),
              ),
              root ? h('div', { className: 'dsdr-path', title: root }, root) : null,
              h('div', { className: 'dsdr-label' }, '项目'),
              h(
                'select',
                {
                  className: 'dsdr-select',
                  value: selected,
                  disabled: building || active || busy || projects.length === 0,
                  title: '选择要运行的项目',
                  'aria-label': '选择要运行的项目',
                  onChange: (event) => setSelected(event.target.value),
                },
                projects.length === 0
                  ? h('option', { value: '' }, '未检测到项目')
                  : projects.map((project) =>
                      h('option', { key: project.path, value: project.path }, project.displayName || project.name),
                    ),
              ),
              h('div', { className: 'dsdr-status', 'data-tone': statusTone || undefined, title: statusText }, statusText),
              state && state.command
                ? h('div', { className: 'dsdr-cmd', title: state.command }, `$ ${state.command}`)
                : null,
              building || active || output
                ? h('pre', { className: 'dsdr-log', ref: logRef }, output || '等待输出…')
                : null,
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dotnet-runner', order: 20 }, Runner),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dotnet-runner-session', order: 999 },
            SessionBridge,
          ),
        )
      },
    }
  },
})
