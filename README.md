# FlowProbe

一个可直接下达任务的桌面客户端：左侧是任务终端与执行记录，右侧是可展开、可亲自操作的真实浏览器。默认模型为 `gpt-6-luna`，网页操作使用 Playwright，整个电脑的操作接入 [agent-desktop](https://github.com/vercel-labs/agent-desktop) 原生驱动。

## 安装 DMG

在 macOS 上运行 `npm run dmg` 生成 `release/FlowProbe-arm64.dmg`（Intel 机器生成对应 x64 文件）。打开 DMG，将 FlowProbe 拖入 Applications 即可安装。应用内“设置”可配置模型、API 地址、执行轮数、截图和普通／暗夜主题。

当前构建使用本地临时签名，尚未使用 Apple Developer ID 签名和公证；分发到其他 Mac 前需要完成正式签名与公证。

应用从本机环境变量读取 `OPENAI_API_KEY`。从 Finder 启动时，若启动环境没有该变量，应用会尝试从 zsh 登录环境读取；可将 `export OPENAI_API_KEY='你的密钥'` 配置在 `~/.zshrc` 中。

## 启动客户端

需要 Node.js ≥22.12。当前本机验证平台是 macOS；其他平台尚未完成真实桌面验证。

```bash
npm ci
export OPENAI_API_KEY='你的密钥'
npm start
```

首次启动会下载 Electron 运行时，并校验官方校验和。内嵌浏览器使用 Electron 自带的 Chromium，无需另外安装 Chrome。模型默认调用 `https://api.openai.com/v1/chat/completions`。可选配置：

```bash
export OPENAI_MODEL='gpt-6-luna'
export OPENAI_BASE_URL='https://api.openai.com/v1'
# 可选 JSON 配置，优先级高于环境变量配置
export FLOWPROBE_MODEL_CONFIG='/绝对路径/model.config.json'
```

程序不自动加载 `.env`。模型请求遵循 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，macOS 代理连接使用 Node 和 Apple 系统根证书，保持 TLS 校验开启。`model.config.example.json` 提供完整配置示例。

## 浏览器任务

1. 在左侧输入任务，也可以先点击“展开浏览器”，在地址栏打开目标页面。
2. 点击执行或按 ⌘/Ctrl + Enter。侧栏展开后，会显示实际页面和操作进度。
3. 执行中可点击“我来操作 / 登录”。程序完成当前操作后暂停，不再点击、输入或抓取新页面观测。
4. 在右侧亲自登录、输入验证码或完成验证，然后点击“继续执行”。程序重新观察页面，并丢弃接管前的旧计划。

任务遇到登录、验证码或其他需要用户处理的步骤时，也可以主动交还控制。用户输入的密码不经过任务输入框；暂停期间不产生新的模型观测。浏览器使用独立的持久化会话，已登录的页面可以在后续任务中复用；正常网站的持久化 Cookie 在重启后保留。弹出式登录窗口使用同一会话。

“打开页面”可在没有模型任务时使用，便于提前登录。任务结束后页面保持打开。浏览器可正常跨站导航；浏览器内容不具有 Node 权限，也不能调用客户端的系统控制接口。

## 整个电脑与可见鼠标

在输入框上方将执行模式切换为“整个电脑”，即可下达跨应用任务。原生驱动支持实际移动鼠标、点击、拖拽、滚轮、键盘快捷键、按可访问性 ref 或当前焦点输入文本和打开应用；每次操作后重新观察桌面。焦点输入在必要时使用原生粘贴，并恢复原剪贴板的各个格式；若用户期间复制了新内容，则保留用户的新内容。模型不能执行任意原生驱动命令。

屏幕上的蓝色光标标记由独立的原生透明窗口绘制，可以显示在其他应用之上，并且不会拦截点击。电脑模式中跟随真实系统鼠标；浏览器模式中标示当前操作目标。操作系统权限不足时，浏览器任务仍然可用；电脑任务会明确拒绝执行。

macOS 首次使用时，点击客户端“系统权限”，展开“快速添加系统权限”面板。分别点击“① 添加辅助功能”和“② 添加屏幕录制”：程序会打开对应的系统设置页，在访达选中 `FlowProbe Driver.app`，并复制其路径。把选中的 App 拖入权限列表并开启即可；也可在添加对话框按 ⌘⇧G 粘贴路径。最后点击“刷新权限状态”。系统最后的授权确认需要用户完成。

驱动 App 在首次构建时由已安装的 agent-desktop 原生文件生成，并保存在 `.flowprobe/native-driver/`，以本地签名保持明确的授权对象。操作通过 macOS LaunchServices 启动这个 App，使实际执行进程获得你授予的权限；它与 Codex Computer Use 的权限相互独立。

电脑模式当前观察主显示器，并使用显示器的逻辑坐标处理 Retina 缩放。截图和可访问性观测会发送给配置的模型服务。登录等人工接管步骤暂停这条观测链路。

“停止”按钮会取消当前任务，保留客户端和浏览器；等待人工操作的任务也可停止。⌘/Ctrl + Shift + . 是全局紧急停止快捷键。

## 本地数据与执行记录

```text
.flowprobe/desktop-profile/      # 内嵌浏览器数据、登录会话、任务对话历史
artifacts/desktop/<执行ID>/
  events.jsonl                  # 观测、模型决策、操作、用量和交还控制事件
  result.json                   # 完成／受阻／取消／错误
  final.png                     # 浏览器任务的最终页面
  desktop-<轮次>.png            # 电脑任务的桌面观测
```

客户端不会把 API 密钥写入任务历史。`done` 表示模型根据观测报告完成，结果中标注 `completionSource: model`。预算按照每次调用的保守费用上限预留；`chargedUsd` 在没有实际费用回报时表示预留金额，不代表账单。

任务对话和浏览器会话保存在本地；点击“执行记录”可打开当前任务的产物目录。不要将本地浏览器配置目录提交到代码仓库。

## 命令行执行

原有直接任务入口仍然可用，适合脚本调用：

```bash
npx playwright install chromium  # CLI 使用独立浏览器时需要
npm run task -- \
  --url 'https://www.selenium.dev/selenium/web/web-form.html' \
  --task '将 Text input 填为 FlowProbe，提交表单并确认结果' \
  --channel chrome
```

CLI 支持 `--vision`、`--headless`、`--slow-mo`、`--keep-open`、`--max-turns`、`--timeout`、`--max-cost` 和可选的 `--model-config`。运行 `npm run task -- --help` 查看参数。CLI 保持同源、同标签页边界，人工接管需要使用桌面客户端。

CLI 产物在 `artifacts/tasks/`，包含 JSONL、结果、截图和 Trace。旧契约测试平台完整归档在 `drop/`，不参与客户端的构建与运行。

## 开发验证

```bash
npx playwright install chromium
npm run check                  # 格式、类型、浏览器执行、控制状态机、构建
npm run test:desktop           # 真正启动 Electron，验证侧栏、人工登录、继续和会话持久化
```

使用本机 Chrome 运行基础测试：`FLOWPROBE_TEST_CHANNEL=chrome npm run check`。Linux 的 Electron 测试需在图形会话中执行，例如 `xvfb-run -a npm run test:desktop`。

本地自动测试使用受控模型响应。独立的真实 OpenAI 验证已在 Selenium 官方表单完成填写、选择、提交和结果核验。桌面权限、物理鼠标和键盘的验证须以当前机器的实际授权状态为准。

主代码位于 `src/desktop`；`src/task.ts` 为浏览器操作循环，`src/control.ts` 负责交还控制和废弃旧计划。构建输出位于 `dist/`。

## 参考实现

- [browser-use](https://github.com/browser-use/browser-use)：参考其浏览器会话、保持浏览器存活、暂停和继续设计；本项目继续使用现有 TypeScript/Playwright 执行代码，没有直接引入 Python Agent。
- [agent-desktop](https://github.com/vercel-labs/agent-desktop)：通过其公开 npm 包调用原生 CLI，使用真实 OS 输入与权限反馈；保留其错误和执行边界。
