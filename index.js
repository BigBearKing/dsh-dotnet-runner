/**
 * Host half of the .NET runner bundle.
 *
 * Detects .NET projects under the workspace directory, exposes a small JSON
 * HTTP API on the Web carrier, and owns the `dotnet` child process. The Client
 * half (client.js) renders the floating Run / Re-run / Stop control.
 */

const ROUTE = '/dotnet-runner'
const PROJECT_FILE = /\.(?:csproj|fsproj|vbproj)$/i
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.vs',
  '.vscode',
  '.idea',
  'bin',
  'obj',
  'node_modules',
  'TestResults',
])
const MAX_SCAN_ENTRIES = 4000
const MAX_PROJECTS = 50
const MAX_DEPTH = 6
const MAX_OUTPUT = 64 * 1024
const MAX_BODY = 64 * 1024

export const inject = ['fs', 'subprocess', 'webServer', 'sessions']

export function apply(ctx, config = {}) {
  const workingDirectory = ctx.get('workingDirectory')
  const configuredRoot = typeof config.root === 'string' ? config.root.trim() : ''
  const dotnetCommand = typeof config.dotnetPath === 'string' && config.dotnetPath.trim()
    ? config.dotnetPath.trim()
    : 'dotnet'
  const scanDepth = Number.isInteger(config.scanDepth)
    ? Math.max(1, Math.min(12, config.scanDepth))
    : MAX_DEPTH
  const maxProjects = Number.isInteger(config.maxProjects)
    ? Math.max(1, Math.min(200, config.maxProjects))
    : MAX_PROJECTS

  let state = idleState('')
  let handle = null
  let output = ''
  let runToken = 0
  let starting = false

  function idleState(message) {
    return {
      phase: 'idle',
      projectPath: null,
      projectName: null,
      mode: null,
      framework: null,
      startedAt: null,
      exitCode: null,
      message: message || '',
      lastLine: '',
      command: '',
    }
  }

  function workspaceFallback() {
    if (configuredRoot) return configuredRoot
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      const workspaces = registry.list()
      if (workspaces.length > 0 && workspaces[0].path) return workspaces[0].path
    }
    return (workingDirectory && workingDirectory.defaultDirectory) || process.cwd()
  }

  // The current workspace is the working directory of the Session the button
  // lives in; `workingDirectory.defaultDirectory` is the profile fallback, not
  // a project folder, so it is only the last resort.
  function resolveRoot(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const session = ctx.sessions.get(sessionId)
      const cwd = session && session.header ? session.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return cwd
    }
    return workspaceFallback()
  }

  async function resolveRootTarget(rootPath) {
    let target
    try {
      target = await ctx.fs.resolve(rootPath)
    } catch {
      throw new Error(`工作区目录无效：${rootPath}`)
    }
    const info = await ctx.fs.stat(target)
    if (!info || info.type !== 'directory') {
      throw new Error(`工作区目录不存在：${rootPath}`)
    }
    return target
  }

  async function detectProjects(sessionId) {
    const rootPath = resolveRoot(sessionId)
    const rootTarget = await resolveRootTarget(rootPath)
    const projects = []
    const queue = [{ target: rootTarget, depth: 0, display: '' }]
    let visited = 0

    while (queue.length > 0 && projects.length < maxProjects && visited < MAX_SCAN_ENTRIES) {
      const current = queue.shift()
      visited += 1
      let entries
      try {
        entries = await ctx.fs.listDir(current.target)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (visited >= MAX_SCAN_ENTRIES || projects.length >= maxProjects) break
        visited += 1
        if (entry.type === 'directory') {
          if (current.depth >= scanDepth) continue
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          queue.push({
            target: entry.target,
            depth: current.depth + 1,
            display: current.display ? `${current.display}/${entry.name}` : entry.name,
          })
        } else if (entry.type === 'file' && PROJECT_FILE.test(entry.name)) {
          const displayFile = current.display ? `${current.display}/${entry.name}` : entry.name
          projects.push({
            path: ctx.fs.processPath(entry.target),
            name: entry.name.replace(/\.[^.]+$/, ''),
            displayName: displayFile.replace(/\.[^.]+$/, ''),
            kind: entry.name.split('.').pop().toLowerCase(),
          })
        }
      }
    }

    projects.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return {
      root: rootPath,
      rootName: rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath,
      projects,
      state,
    }
  }

  async function readProjectMeta(target, fallbackName) {
    let text = ''
    try {
      text = await ctx.fs.readText(target)
    } catch {
      text = ''
    }
    const useMaui = /<UseMaui>\s*true\s*<\/UseMaui>/i.test(text)
    const frameworks = []
    const pattern = /<TargetFrameworks?[^>]*>([\s\S]*?)<\/TargetFrameworks?>/gi
    let match
    while ((match = pattern.exec(text)) !== null) {
      for (const part of match[1].split(';')) {
        const value = part.trim()
        if (/^net\d/i.test(value) && !value.includes('$(') && !frameworks.includes(value)) {
          frameworks.push(value)
        }
      }
    }
    const assembly = (text.match(/<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/i) || [])[1]
    return { useMaui, frameworks, name: assembly || fallbackName }
  }

  function chooseFramework(meta) {
    if (meta.frameworks.length === 0) return undefined
    const pool = runnableFrameworks(meta.frameworks)
    const preferred = process.platform === 'darwin'
      ? /maccatalyst/i
      : process.platform === 'win32'
        ? /windows/i
        : /maccatalyst|windows/i
    return pool.find((value) => preferred.test(value)) || pool[0]
  }

  function buildPlan(meta, projectPath, projectDir, executable, selection) {
    const framework = (selection && selection.framework) || chooseFramework(meta)
    const kind = selection ? selection.kind : ''
    const mode = meta.useMaui ? 'maui' : 'run'
    const frameworkArgs = framework ? ['-f', framework] : []

    const buildArgs = [...frameworkArgs]
    if (kind === 'ios-simulator') buildArgs.push(`-p:RuntimeIdentifier=${simulatorRid()}`)
    else if (kind === 'ios-device') buildArgs.push('-p:RuntimeIdentifier=ios-arm64')

    const build = {
      argv: [executable, 'build', projectPath, '--nologo', ...buildArgs],
      cwd: projectDir,
    }

    let runArgv
    if (meta.useMaui) {
      const runArgs = [...frameworkArgs]
      if (kind === 'ios-simulator' && selection.target) {
        runArgs.push(`-p:RuntimeIdentifier=${simulatorRid()}`, `-p:_DeviceName=:v2:udid=${selection.target}`)
      } else if (kind === 'ios-device' && selection.target) {
        runArgs.push('-p:RuntimeIdentifier=ios-arm64', `-p:_DeviceName=:v2:udid=${selection.target}`)
      } else if (kind === 'android-device' && selection.target) {
        runArgs.push(`-p:AdbTarget=-s ${selection.target}`)
      }
      runArgv = mauiRunArgv(executable, projectPath, runArgs)
    } else {
      runArgv = [
        executable,
        'run',
        '--no-build',
        '--project',
        projectPath,
        ...(framework && meta.frameworks.length > 1 ? ['-f', framework] : []),
      ]
    }

    return {
      build,
      run: { argv: runArgv, cwd: projectDir },
      mode,
      framework,
      selection: {
        framework: framework || '',
        kind: kind || 'default',
        target: selection && selection.target ? selection.target : '',
      },
    }
  }

  function mauiRunArgv(executable, projectPath, args) {
    return [executable, 'build', '-t:Run', '--no-restore', '--nologo', projectPath, ...args]
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  function readCollected(child, channel) {
    try {
      const reader = child.collected && child.collected[channel]
      return reader ? reader.readFrom(0).text || '' : ''
    } catch {
      return ''
    }
  }

  function runCapture(argv, timeoutMs = 10000) {
    return new Promise((resolve) => {
      let child
      try {
        child = ctx.subprocess.spawn({
          argv,
          cwd: process.cwd(),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 2 * 1024 * 1024 },
            stderr: { maxBytes: 64 * 1024 },
          },
          graceMs: 500,
        })
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: errorText(error) })
        return
      }

      let settled = false
      const finish = (code) => {
        if (settled) return
        settled = true
        resolve({ code, stdout: readCollected(child, 'stdout'), stderr: readCollected(child, 'stderr') })
      }
      const timer = setTimeout(() => {
        try {
          child.terminate()
        } catch {
          // The probe already exited.
        }
        finish(null)
      }, timeoutMs)
      child.done.then(
        (outcome) => {
          clearTimeout(timer)
          finish(outcome ? outcome.exitCode : null)
        },
        () => {
          clearTimeout(timer)
          finish(null)
        },
      )
    })
  }

  function androidSdkRoots() {
    const home = process.env.HOME || ''
    return [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      home ? `${home}/Library/Android/sdk` : '',
      '/usr/local/share/android-sdk',
      '/opt/homebrew/share/android-commandlinetools',
    ].filter(Boolean)
  }

  async function findAndroidTool(relative) {
    for (const root of androidSdkRoots()) {
      const candidate = `${root}/${relative}`
      try {
        const target = await ctx.fs.resolve(candidate)
        const info = await ctx.fs.stat(target)
        if (info && info.type === 'file') return ctx.fs.processPath(target)
      } catch {
        // Try the next SDK root.
      }
    }
    return undefined
  }

  async function listIosPhysicalDevices() {
    if (process.platform !== 'darwin') return []

    const found = []
    const result = await runCapture(['/usr/bin/xcrun', 'devicectl', 'list', 'devices'], 20000)
    for (const raw of String(result.stdout || '').split('\n')) {
      const line = raw.trimEnd()
      if (!line || /^Name\s/.test(line.trim())) continue
      const match = line.match(/([0-9A-Fa-f-]{20,40}) \(UDID\)/)
      if (!match) continue
      const name = line.slice(0, match.index).trim()
      const rest = line
        .slice(match.index + match[0].length)
        .trim()
        .split(/\s{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
      const reality = rest[rest.length - 1] || ''
      if (reality !== 'physical') continue
      const state = rest[0] || ''
      if (state !== 'connected') continue
      const model = rest.length > 2 ? rest[rest.length - 2] : ''
      found.push({ udid: match[1], name: name || model || 'iOS 设备', model })
    }
    if (found.length > 0) return found

    // Older Xcode versions have no devicectl; xctrace still lists wired devices.
    const fallback = await runCapture(['/usr/bin/xcrun', 'xctrace', 'list', 'devices'], 20000)
    let inDevices = false
    for (const raw of String(fallback.stdout || '').split('\n')) {
      const line = raw.trim()
      if (/^== Devices ==/.test(line)) {
        inDevices = true
        continue
      }
      if (/^== /.test(line)) {
        inDevices = false
        continue
      }
      if (!inDevices || !line) continue
      const match = line.match(/^(.*) \([^()]*\) \(([0-9A-Fa-f-]{20,40})\)$/)
      if (!match || /Mac/i.test(match[1])) continue
      found.push({ udid: match[2], name: match[1], model: '' })
    }
    return found
  }

  async function listIosSimulators() {
    if (process.platform !== 'darwin') return []
    const result = await runCapture(['/usr/bin/xcrun', 'simctl', 'list', 'devices', 'available', '--json'], 15000)
    if (!result.stdout) return []
    let parsed
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return []
    }
    const simulators = []
    for (const [runtime, list] of Object.entries(parsed.devices || {})) {
      if (!/iOS/i.test(runtime)) continue
      const version = ((runtime.match(/iOS-([0-9-]+)/) || [])[1] || '').replace(/-/g, '.')
      for (const entry of list || []) {
        if (!entry || !entry.udid || entry.isAvailable === false) continue
        simulators.push({ udid: entry.udid, name: entry.name, state: entry.state, version })
      }
    }
    return simulators
  }

  async function listAndroidDevices() {
    const adb = await findAndroidTool('platform-tools/adb')
    if (!adb) return []
    const result = await runCapture([adb, 'devices', '-l'], 10000)
    const devices = []
    for (const line of String(result.stdout || '').split('\n')) {
      const text = line.trim()
      if (!text || /^List of devices/i.test(text)) continue
      const parts = text.split(/\s+/)
      if (parts.length < 2 || parts[1] !== 'device') continue
      const model = (text.match(/model:(\S+)/) || [])[1] || parts[0]
      devices.push({ serial: parts[0], model: model.replace(/_/g, ' ') })
    }
    return devices
  }

  async function listAndroidAvds() {
    const emulator = await findAndroidTool('emulator/emulator')
    if (!emulator) return []
    const result = await runCapture([emulator, '-list-avds'], 10000)
    return String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async function startAndroidAvd(name) {
    const emulator = await findAndroidTool('emulator/emulator')
    if (!emulator) throw new Error('找不到 Android emulator，请确认已安装 Android SDK')
    const before = new Set((await listAndroidDevices()).map((device) => device.serial))
    try {
      ctx.subprocess.spawn({
        argv: [emulator, '-avd', name],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 1000,
      })
    } catch (error) {
      throw new Error(`无法启动模拟器 ${name}：${errorText(error)}`)
    }
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      await delay(2000)
      const devices = await listAndroidDevices()
      const fresh = devices.find((device) => !before.has(device.serial))
      if (fresh) return fresh.serial
    }
    throw new Error(`模拟器 ${name} 在 120 秒内没有就绪`)
  }

  async function ensureIosSimulatorBooted(udid) {
    await runCapture(['/usr/bin/xcrun', 'simctl', 'boot', udid], 30000)
  }

  async function detectDevices(meta) {
    const devices = []
    for (const framework of runnableFrameworks(meta.frameworks)) {
      if (/-maccatalyst|-macos/i.test(framework)) {
        devices.push({ id: `local:${framework}`, label: '本机', framework, kind: 'maccatalyst', target: '' })
        continue
      }
      if (/-ios/i.test(framework)) {
        const physical = await listIosPhysicalDevices()
        const simulators = await listIosSimulators()
        for (const device of physical) {
          devices.push({
            id: `ios-device:${device.udid}`,
            label: `${device.name}${device.model ? ` · ${device.model}` : ''}（真机）`,
            framework,
            kind: 'ios-device',
            target: device.udid,
          })
        }
        if (simulators.length === 0 && physical.length === 0) {
          devices.push({ id: `tfm:${framework}`, label: '默认模拟器', framework, kind: 'default', target: '' })
        } else {
          for (const simulator of simulators) {
            devices.push({
              id: `ios-sim:${simulator.udid}`,
              label: `${simulator.name}${simulator.version ? ` · iOS ${simulator.version}` : ''}`,
              framework,
              kind: 'ios-simulator',
              target: simulator.udid,
              detail: simulator.state,
            })
          }
        }
        continue
      }
      if (/-android/i.test(framework)) {
        const serials = await listAndroidDevices()
        const avds = serials.length > 0 ? [] : await listAndroidAvds()
        for (const device of serials) {
          devices.push({
            id: `android:${device.serial}`,
            label: `${device.model}（已连接）`,
            framework,
            kind: 'android-device',
            target: device.serial,
          })
        }
        for (const avd of avds) {
          devices.push({
            id: `avd:${avd}`,
            label: `${avd}（模拟器）`,
            framework,
            kind: 'android-avd',
            target: avd,
          })
        }
        if (serials.length === 0 && avds.length === 0) {
          devices.push({ id: `tfm:${framework}`, label: '默认设备', framework, kind: 'default', target: '' })
        }
        continue
      }
      devices.push({ id: `tfm:${framework}`, label: deviceLabel(framework), framework, kind: 'default', target: '' })
    }
    return devices
  }

  function normalizeSelection(device, meta) {
    const source = device && typeof device === 'object' ? device : {}
    const framework = typeof source.framework === 'string' ? source.framework : ''
    const kind = typeof source.kind === 'string' && source.kind ? source.kind : 'default'
    const target = typeof source.target === 'string' ? source.target : ''
    if (framework && !meta.frameworks.includes(framework)) {
      throw new Error(`未知的设备框架：${framework}`)
    }
    if (!['default', 'maccatalyst', 'ios-simulator', 'ios-device', 'android-device', 'android-avd'].includes(kind)) {
      throw new Error('未知的设备类型')
    }
    if ((kind === 'ios-simulator' || kind === 'ios-device') && !/^[0-9A-Fa-f-]{20,40}$/.test(target)) {
      throw new Error('无效的模拟器 ID')
    }
    if (kind === 'android-device' && !/^[A-Za-z0-9._:-]{1,128}$/.test(target)) {
      throw new Error('无效的 Android 设备')
    }
    if (kind === 'android-avd' && !/^[A-Za-z0-9._ -]{1,128}$/.test(target)) {
      throw new Error('无效的 Android 模拟器名称')
    }
    return { framework, kind, target }
  }

  function dotnetCandidates() {
    const home = process.env.HOME || ''
    return [
      process.env.DOTNET_ROOT ? `${process.env.DOTNET_ROOT}/dotnet` : '',
      home ? `${home}/.dotnet/dotnet` : '',
      '/usr/local/share/dotnet/dotnet',
      '/opt/homebrew/bin/dotnet',
      '/usr/local/bin/dotnet',
      '/usr/bin/dotnet',
    ].filter(Boolean)
  }

  // A desktop-launched Harness inherits launchd's minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), so a dotnet installed under the user's
  // home is invisible to resolveExecutable. Probe the usual install roots.
  async function resolveDotnetExecutable() {
    if (dotnetCommand.includes('/')) {
      const target = await ctx.fs.resolve(dotnetCommand).catch(() => undefined)
      if (target) {
        const info = await ctx.fs.stat(target).catch(() => undefined)
        if (info && info.type === 'file') return ctx.fs.processPath(target)
      }
      throw new Error(`找不到可执行文件：${dotnetCommand}`)
    }

    try {
      return await ctx.subprocess.resolveExecutable(dotnetCommand)
    } catch {
      // Fall through to the well-known install locations.
    }

    for (const candidate of dotnetCandidates()) {
      try {
        const target = await ctx.fs.resolve(candidate)
        const info = await ctx.fs.stat(target)
        if (info && info.type === 'file') return ctx.fs.processPath(target)
      } catch {
        // Try the next candidate.
      }
    }

    throw new Error(`找不到 ${dotnetCommand}，已尝试 PATH 以及：${dotnetCandidates().join('、')}`)
  }

  async function listDirectory(path) {
    try {
      const target = await ctx.fs.resolve(path)
      const info = await ctx.fs.stat(target)
      if (!info || info.type !== 'directory') return undefined
      return { target, entries: await ctx.fs.listDir(target) }
    } catch {
      return undefined
    }
  }

  async function appBundleExecutable(appTarget, assemblyName) {
    const macos = await listDirectory(`${ctx.fs.processPath(appTarget)}/Contents/MacOS`)
    if (!macos) return undefined
    const exact = macos.entries.find((entry) => entry.type === 'file' && entry.name === assemblyName)
    if (exact) return ctx.fs.processPath(exact.target)
    const candidate = macos.entries.find((entry) => entry.type === 'file' && !entry.name.startsWith('.'))
    return candidate ? ctx.fs.processPath(candidate.target) : undefined
  }

  // MAUI's `-t:Run` target launches the app bundle and then exits, so the Host
  // would lose the process it needs for Stop. Find the built app executable and
  // spawn it directly: it stays alive until the user quits it.
  async function findBuiltExecutable(projectDir, framework, assemblyName) {
    const roots = framework
      ? [`${projectDir}/bin/Debug/${framework}`, `${projectDir}/bin/Release/${framework}`]
      : [`${projectDir}/bin/Debug`, `${projectDir}/bin/Release`]

    for (const rootPath of roots) {
      const root = await listDirectory(rootPath)
      if (!root) continue

      const direct = root.entries.find(
        (entry) => entry.type === 'file' && (entry.name === `${assemblyName}.exe` || entry.name === assemblyName),
      )
      if (direct) return ctx.fs.processPath(direct.target)

      const apps = []
      for (const entry of root.entries) {
        if (entry.type !== 'directory') continue
        if (entry.name.endsWith('.app')) {
          apps.push(entry)
          continue
        }
        const nested = await listDirectory(ctx.fs.processPath(entry.target))
        if (!nested) continue
        for (const child of nested.entries) {
          if (child.type === 'file' && (child.name === `${assemblyName}.exe` || child.name === assemblyName)) {
            return ctx.fs.processPath(child.target)
          }
          if (child.type === 'directory' && child.name.endsWith('.app')) apps.push(child)
        }
      }

      const preferred = apps.find((entry) => entry.name === `${assemblyName}.app`) || apps[0]
      if (preferred) {
        const executable = await appBundleExecutable(preferred.target, assemblyName)
        if (executable) return executable
      }
    }

    return undefined
  }

  function spawnProcess(spec, executable) {
    const pathParts = [
      executable ? directoryOf(executable) : '',
      process.env.HOME ? `${process.env.HOME}/.dotnet` : '',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      process.env.PATH || '',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].filter(Boolean)
    return ctx.subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2000,
      env: { ...process.env, PATH: [...new Set(pathParts)].join(':') },
    })
  }

  function attachProcessOutput(child, token) {
    const append = (chunk) => {
      const text = String(chunk)
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
      output = (output + text).slice(-MAX_OUTPUT)
      if (token === runToken) state = { ...state, lastLine: lastLineOf(output) }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
  }

  async function inspectProject(requestPath, sessionId) {
    if (typeof requestPath !== 'string' || requestPath.trim() === '') {
      throw new Error('缺少项目路径')
    }
    if (!PROJECT_FILE.test(requestPath)) {
      throw new Error('不是 .NET 项目文件')
    }
    const rootTarget = await resolveRootTarget(resolveRoot(sessionId))
    let target
    try {
      target = await ctx.fs.resolve(requestPath)
    } catch {
      throw new Error(`项目路径无效：${requestPath}`)
    }
    if (!ctx.fs.contains(rootTarget, target)) {
      throw new Error('项目必须位于当前工作区内')
    }
    const info = await ctx.fs.stat(target)
    if (!info || info.type !== 'file') {
      throw new Error(`项目文件不存在：${requestPath}`)
    }

    const baseName = requestPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
    const meta = await readProjectMeta(target, baseName)
    const devices = await detectDevices(meta)
    const preferredFramework = chooseFramework(meta) || ''
    const preferred = devices.find((device) => device.framework === preferredFramework) || devices[0]
    return {
      project: ctx.fs.processPath(target),
      name: meta.name,
      useMaui: meta.useMaui,
      devices,
      defaultDeviceId: preferred ? preferred.id : '',
    }
  }

  async function startRun(requestPath, sessionId, device) {
    if (starting) return state
    if (typeof requestPath !== 'string' || requestPath.trim() === '') {
      throw new Error('缺少要运行的项目路径')
    }
    if (!PROJECT_FILE.test(requestPath)) {
      throw new Error('只能运行 .csproj / .fsproj / .vbproj 项目')
    }

    starting = true
    try {
      if (handle) await stopRun()

      const rootPath = resolveRoot(sessionId)
      const rootTarget = await resolveRootTarget(rootPath)
      let target
      try {
        target = await ctx.fs.resolve(requestPath)
      } catch {
        throw new Error(`项目路径无效：${requestPath}`)
      }
      if (!ctx.fs.contains(rootTarget, target)) {
        throw new Error('项目必须位于当前工作区内')
      }
      const info = await ctx.fs.stat(target)
      if (!info || info.type !== 'file') {
        throw new Error(`项目文件不存在：${requestPath}`)
      }

      const projectPath = ctx.fs.processPath(target)
      const projectDir = directoryOf(projectPath)
      const baseName = requestPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
      const meta = await readProjectMeta(target, baseName)
      const selection = normalizeSelection(device, meta)
      const executable = await resolveDotnetExecutable()

      const plan = buildPlan(meta, projectPath, projectDir, executable, selection)
      output = ''
      const token = ++runToken

      state = {
        phase: 'building',
        projectPath,
        projectName: meta.name,
        mode: plan.mode,
        framework: plan.framework || null,
        startedAt: Date.now(),
        exitCode: null,
        message: '正在编译',
        lastLine: '',
        command: formatCommand(plan.build.argv),
      }

      let buildChild
      try {
        buildChild = spawnProcess(plan.build, executable)
      } catch (error) {
        throw new Error(`无法启动编译：${errorText(error)}`)
      }
      handle = buildChild
      attachProcessOutput(buildChild, token)

      buildChild.done.then(
        async (outcome) => {
          if (token !== runToken) return
          handle = null
          const code = outcome ? outcome.exitCode : null
          if (code !== 0) {
            state = {
              ...state,
              phase: 'failed',
              exitCode: code,
              message: `编译失败${code === null ? '' : `（退出码 ${code}）`}`,
              lastLine: lastLineOf(output),
            }
            return
          }

          let runSpec = plan.run
          let runCommand = formatCommand(plan.run.argv)
          let runningMessage = '运行中'
          let launchedApp = false

          if (plan.mode === 'maui') {
            const kind = plan.selection.kind
            if (kind === 'ios-simulator') {
              await ensureIosSimulatorBooted(plan.selection.target)
              if (token !== runToken) return
              runningMessage = '正在安装到模拟器'
            } else if (kind === 'ios-device') {
              runningMessage = '正在安装到设备'
            } else if (kind === 'android-device') {
              runningMessage = '正在安装到设备'
            } else if (kind === 'android-avd') {
              let serial
              try {
                serial = await startAndroidAvd(plan.selection.target)
              } catch (error) {
                if (token !== runToken) return
                state = {
                  ...state,
                  phase: 'failed',
                  exitCode: null,
                  message: `启动模拟器失败：${errorText(error)}`,
                  lastLine: lastLineOf(output),
                }
                return
              }
              if (token !== runToken) return
              runSpec = {
                argv: mauiRunArgv(executable, projectPath, [
                  ...(plan.framework ? ['-f', plan.framework] : []),
                  `-p:AdbTarget=-s ${serial}`,
                ]),
                cwd: projectDir,
              }
              runCommand = formatCommand(runSpec.argv)
              runningMessage = '正在安装到模拟器'
            } else {
              runningMessage = '正在启动应用'
              const appExecutable = await findBuiltExecutable(projectDir, plan.framework, meta.name).catch(
                () => undefined,
              )
              if (token !== runToken) return
              if (appExecutable) {
                runSpec = { argv: [appExecutable], cwd: projectDir }
                runCommand = appExecutable
                runningMessage = '应用运行中'
                launchedApp = true
              }
            }
          }

          let runChild
          try {
            runChild = spawnProcess(runSpec, executable)
          } catch (error) {
            if (runSpec !== plan.run) {
              try {
                runSpec = plan.run
                runCommand = formatCommand(plan.run.argv)
                runningMessage = plan.mode === 'maui' ? '正在启动应用' : '运行中'
                launchedApp = false
                runChild = spawnProcess(runSpec, executable)
              } catch {
                runChild = undefined
              }
            }
            if (!runChild) {
              state = {
                ...state,
                phase: 'failed',
                exitCode: null,
                message: `启动失败：${errorText(error)}`,
                lastLine: lastLineOf(output),
              }
              return
            }
          }

          handle = runChild
          output = `${output}\n$ ${runCommand}\n`
          state = {
            ...state,
            phase: 'running',
            exitCode: null,
            message: runningMessage,
            lastLine: '',
            command: runCommand,
          }
          attachProcessOutput(runChild, token)

          runChild.done.then(
            (runOutcome) => {
              if (token !== runToken) return
              handle = null
              const runCode = runOutcome ? runOutcome.exitCode : null
              const ok = runCode === 0
              state = {
                ...state,
                phase: ok ? 'exited' : 'failed',
                exitCode: runCode,
                message: ok
                  ? (launchedApp ? '应用已退出' : plan.mode === 'maui' ? '编译并启动完成' : '运行结束')
                  : `运行失败${runCode === null ? '' : `（退出码 ${runCode}）`}`,
                lastLine: lastLineOf(output),
              }
            },
            (error) => {
              if (token !== runToken) return
              handle = null
              state = {
                ...state,
                phase: 'failed',
                exitCode: null,
                message: `运行失败：${errorText(error)}`,
                lastLine: lastLineOf(output),
              }
            },
          )
        },
        (error) => {
          if (token !== runToken) return
          handle = null
          state = {
            ...state,
            phase: 'failed',
            exitCode: null,
            message: `编译失败：${errorText(error)}`,
            lastLine: lastLineOf(output),
          }
        },
      )

      return state
    } finally {
      starting = false
    }
  }

  async function stopRun() {
    const current = handle
    runToken += 1
    handle = null
    if (current) {
      try {
        current.terminate()
      } catch {
        // The provider may already have exited the process.
      }
      try {
        await withTimeout(current.done, 8000)
      } catch {
        // A termination race is not worth surfacing to the button.
      }
    }
    state = idleState('已停止')
    return state
  }

  function isTrustedRequest(req) {
    const host = String(req.headers.host || '').toLowerCase()
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false
    if (req.method === 'POST') {
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        let expected
        try {
          expected = ctx.webServer.getOrigin()
        } catch {
          return false
        }
        if (origin !== expected) return false
      }
    }
    return true
  }

  const handler = async (req, res) => {
    try {
      if (!isTrustedRequest(req)) {
        return sendJson(res, 403, { ok: false, error: '拒绝访问' })
      }
      const url = new URL(req.url || '/', 'http://localhost')

      const sessionId = url.searchParams.get('session') || ''

      if (req.method === 'GET' && url.pathname === `${ROUTE}/projects`) {
        const result = await detectProjects(sessionId)
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && url.pathname === `${ROUTE}/project`) {
        const result = await inspectProject(url.searchParams.get('path') || '', sessionId)
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && url.pathname === `${ROUTE}/status`) {
        const statusRoot = resolveRoot(sessionId)
        return sendJson(res, 200, {
          ok: true,
          root: statusRoot,
          rootName: rootNameOf(statusRoot),
          state,
          output: output.length > 16000 ? output.slice(-16000) : output,
        })
      }
      if (req.method === 'POST' && url.pathname === `${ROUTE}/start`) {
        const payload = await readJsonBody(req)
        const device = (payload && payload.device)
          || (payload && payload.framework ? { framework: payload.framework } : undefined)
        const next = await startRun(payload && payload.path, payload && payload.sessionId, device)
        return sendJson(res, 200, { ok: true, state: next })
      }
      if (req.method === 'POST' && url.pathname === `${ROUTE}/stop`) {
        const next = await stopRun()
        return sendJson(res, 200, { ok: true, state: next })
      }
      return sendJson(res, 404, { ok: false, error: '未知接口' })
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: errorText(error), state })
    }
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler })
    return () => {
      unregister()
      runToken += 1
      const current = handle
      handle = null
      if (current) {
        try {
          current.terminate()
        } catch {
          // Nothing left to stop.
        }
      }
    }
  }, 'dotnet-runner: http route')
}

function rootNameOf(path) {
  return String(path).split(/[\\/]/).filter(Boolean).pop() || String(path)
}

function simulatorRid() {
  return process.arch === 'arm64' ? 'iossimulator-arm64' : 'iossimulator-x64'
}

function runnableFrameworks(frameworks) {
  const runnable = frameworks.filter((framework) => {
    if (/-windows/i.test(framework)) return process.platform === 'win32'
    if (/-ios|-maccatalyst|-macos|-tvos/i.test(framework)) return process.platform === 'darwin'
    return true
  })
  return runnable.length > 0 ? runnable : frameworks
}

function deviceLabel(framework) {
  const value = String(framework)
  if (/maccatalyst/i.test(value)) return 'Mac Catalyst'
  if (/-ios/i.test(value)) return 'iOS'
  if (/-android/i.test(value)) return 'Android'
  if (/-windows/i.test(value)) return 'Windows'
  if (/-tvos/i.test(value)) return 'tvOS'
  if (/-macos/i.test(value)) return 'macOS'
  return value
}

function directoryOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : path
}

function formatCommand(argv) {
  return argv
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(' ')
}

function lastLineOf(text) {
  const lines = String(text)
    .replace(/\r/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => line.trim() !== '')
  const line = lines.length > 0 ? lines[lines.length - 1].trim() : ''
  return line.length > 240 ? `${line.slice(0, 237)}...` : line
}

function errorText(error) {
  return error instanceof Error && error.message ? error.message : String(error)
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // The socket is already gone.
    }
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
