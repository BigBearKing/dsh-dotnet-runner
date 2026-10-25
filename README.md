# dsh-dotnet-runner

DeepSeek Harness（DSH）Web 插件：自动检测当前会话工作区里的 .NET 项目，在界面右下角提供「运行 / 重新运行 / 停止」三个按钮，并在「更多」面板里显示正在执行的 `dotnet` 命令和实时终端输出。

## 功能

- 以当前会话的工作目录作为工作区，递归查找 `*.csproj` / `*.fsproj` / `*.vbproj`（跳过 `.git`、`bin`、`obj`、`node_modules`、`.vs` 等目录）
- 一个工作区有多个项目时，可在「更多」面板的下拉框里切换
- 普通项目：`dotnet build` 成功后执行 `dotnet run --no-build`
- MAUI 项目：`dotnet build` 成功后直接启动构建产物（macOS 上为 `*.app/Contents/MacOS/<AssemblyName>`），保持进程存活，因此「停止」可以真正结束 App
- 编译期间「运行」「停止」和项目下拉框禁用，绿色按钮显示转圈；「更多」始终可用
- 「更多」面板显示当前命令、工作区路径、项目选择和终端输出（约 900ms 刷新，自动滚动）
- 仅使用本地 HTTP 路由与 `ctx.fs` / `ctx.subprocess`，不引入任何第三方依赖

## 环境要求

- 已安装并登录的 DSH（Web GUI）
- .NET SDK（`dotnet` 在 PATH 中，或位于 `~/.dotnet/dotnet`、`/usr/local/share/dotnet/dotnet`、`/opt/homebrew/bin/dotnet` 等常见位置）
- MAUI 项目需要对应平台的工作负载

## 安装

1. 克隆本仓库：

   ```bash
   git clone https://github.com/BigBearKing/dsh-dotnet-runner.git
   ```

2. 在 DSH 里把该目录作为本地 bundle 安装（`package.json` 已声明 `dsh.bundle.patch`），例如通过 Plugin Manager 的本地目录安装，或让 DSH 的 agent 执行 `plugin_manager` 的 `install_bundle`，目标为仓库的绝对路径。

3. 刷新 DSH 页面，右下角出现三个按钮。

## 可选配置

在 `cordis.patch.yml` 对应行的 `config` 中可覆盖：

```yaml
- insert:
    - id: dotnet-runner
      name: '@local/dotnet-runner'
      config:
        root: /path/to/workspace   # 覆盖工作区根目录
        dotnetPath: /usr/local/share/dotnet/dotnet  # 覆盖 dotnet 可执行文件
        scanDepth: 6               # 最大扫描深度
        maxProjects: 50            # 最多收集的项目数
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：扫描项目、解析 csproj、编译/运行子进程、`/dotnet-runner` HTTP 路由 |
| `client.js` | Client 半：`shell.overlay` 浮动按钮、`conversation.composer.dock` 会话桥、状态轮询 |
| `cordis.patch.yml` | Bundle patch |
| `locale/*.json` | 插件标题与描述 |
| `icon.svg` | 插件图标 |

## 说明

- 工作区来自当前会话的 `cwd`；取不到时依次回退到 `config.root`、第一个已注册工作区、DSH 的默认目录。
- macOS 上启动的 App 是插件的子进程，点「停止」会结束该进程；从 Finder 手动打开的实例不受管理。
- 插件的 HTTP 路由仅接受本机回环地址，并对 POST 请求校验 `Origin`。
