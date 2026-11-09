import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  globalShortcut,
  session,
  shell,
  clipboard,
  nativeImage,
} from 'electron';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { resolveModelConfig } from '../config.js';
import { HttpModelProvider, ModelGateway } from '../model.js';
import { executeTask } from '../task.js';
import { TaskControl } from '../control.js';
import { errorInfo } from '../errors.js';
import { writeJson, readJson } from '../files.js';
import { NativeDesktop } from './native.js';
import { DesktopPointer } from './pointer.js';
import { executeComputerTask } from './computer.js';

const here = dirname(fileURLToPath(import.meta.url));
const installed = app.isPackaged || existsSync(join(process.resourcesPath, 'flowprobe-packaged'));
const root = installed ? app.getAppPath() : resolve(here, '../..');
const dataRoot = installed ? join(app.getPath('appData'), 'FlowProbe') : root;
const profile = resolve(
  process.env['FLOWPROBE_PROFILE'] || join(dataRoot, '.flowprobe/desktop-profile'),
);
mkdirSync(profile, { recursive: true });
app.setName('FlowProbe');
app.setPath('userData', profile);
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch(
  'remote-debugging-port',
  process.env['FLOWPROBE_CDP_PORT'] || String(40000 + Math.floor(Math.random() * 20000)),
);

const inputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('run'),
      task: z.string().trim().min(1).max(20000),
      mode: z.enum(['browser', 'desktop']),
      url: z.string().max(4000).optional(),
    })
    .strict(),
  z.object({ type: z.literal('open'), url: z.string().min(1).max(4000) }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('state') }).strict(),
  z.object({ type: z.literal('settings-visible'), visible: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('save-settings'),
      model: z.string().trim().min(1).max(100),
      baseUrl: z.url(),
      maxTurns: z.number().int().min(1).max(200),
      vision: z.boolean(),
      theme: z.enum(['light', 'dark']).default('dark'),
    })
    .strict(),
  z.object({ type: z.literal('permissions') }).strict(),
  z.object({ type: z.literal('refresh-permissions') }).strict(),
  z.object({ type: z.literal('toggle-browser') }).strict(),
  z.object({ type: z.literal('back') }).strict(),
  z.object({ type: z.literal('forward') }).strict(),
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('artifacts') }).strict(),
  z.object({ type: z.literal('show-driver') }).strict(),
  z.object({ type: z.literal('show-client') }).strict(),
  z
    .object({
      type: z.literal('quick-permission'),
      permission: z.enum(['accessibility', 'screen']),
    })
    .strict(),
]);
let window: BrowserWindow;
let view: WebContentsView;
let browser: Browser;
let page: Page;
let pointer: DesktopPointer;
const driver = new NativeDesktop();
let task: { abort: AbortController; control: TaskControl; finished: Promise<void> } | undefined;
let expanded = false;
let ready = false;
let settingsVisible = false;
const settingsFile = join(profile, 'settings.json');
let settings = {
  model: process.env['OPENAI_MODEL'] || 'gpt-6-luna',
  baseUrl: process.env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1',
  maxTurns: 60,
  vision: true,
  theme: 'dark' as 'light' | 'dark',
};
const state: Record<string, unknown> = {
  status: 'idle',
  ready: false,
  expanded: false,
  url: '',
  title: '',
  model: process.env['OPENAI_MODEL'] || 'gpt-6-luna',
  mode: 'browser',
  messages: [],
  events: [],
  calls: 0,
  hasKey: Boolean(process.env['OPENAI_API_KEY']),
  permissions: null,
  artifactDirectory: '',
  desktopImage: '',
  sidebarWidth: 460,
  settings,
};
const messages = state['messages'] as Record<string, unknown>[];
const historyFile = join(profile, 'client-history.json');
function saveHistory() {
  try {
    writeFileSync(
      historyFile,
      JSON.stringify({
        messages: messages.slice(-100),
        lastUrl: state['url'],
        artifactDirectory: state['artifactDirectory'],
      }),
      { mode: 0o600 },
    );
  } catch {}
}
const events = state['events'] as Record<string, unknown>[];
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('flowprobe:state', state);
}
function message(role: string, text: string) {
  messages.push({ id: randomUUID(), role, text, at: new Date().toISOString() });
  saveHistory();
  publish();
}
function status(value: string) {
  state['status'] = value;
  publish();
}
function layout() {
  if (!window || window.isDestroyed()) return;
  const [width = 1400, height = 900] = window.getContentSize();
  const left = Math.min(460, Math.max(340, Math.floor(width * 0.36)));
  state['sidebarWidth'] = left;
  view.setBounds({
    x: left,
    y: 104,
    width: Math.max(1, width - left),
    height: Math.max(1, height - 138),
  });
  view.setVisible(expanded && state['mode'] !== 'desktop' && !settingsVisible);
  state['expanded'] = expanded;
  publish();
}
function normalizeUrl(input: string): string {
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请输入不包含凭据的 HTTP(S) 网址');
  return url.href;
}
async function refreshPermissions() {
  try {
    const data = await driver.run(['permissions']);
    state['permissions'] = data;
  } catch (error) {
    state['permissions'] = { error: errorInfo(error).message };
  }
  publish();
}
async function openPage(url: string) {
  if (!ready) throw new Error('浏览器仍在启动，请稍候');
  if (task) await task.control.pause();
  expanded = true;
  state['mode'] = 'browser';
  layout();
  await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
  view.webContents.focus();
}
async function connectBrowser() {
  let port = Number(
    process.env['FLOWPROBE_CDP_PORT'] || app.commandLine.getSwitchValue('remote-debugging-port'),
  );
  if (!port) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        if (port) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!port) throw new Error('无法连接内嵌浏览器的调试端口，请使用 npm start 启动');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('#flowprobe-browser'));
    if (match) {
      page = match;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('内嵌页面未就绪');
}
async function startTask(instruction: string, mode: 'browser' | 'desktop', url?: string) {
  if (!ready) throw new Error('客户端仍在启动，请稍候');
  if (task) throw new Error('请先停止当前任务，或等待它完成');
  const config = process.env['FLOWPROBE_MODEL_CONFIG']
    ? resolveModelConfig(await readJson(resolve(process.env['FLOWPROBE_MODEL_CONFIG'])))
    : resolveModelConfig(undefined, {
        ...process.env,
        OPENAI_MODEL: settings.model,
        OPENAI_BASE_URL: settings.baseUrl,
        OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      });
  if (config.keyEnv && !process.env[config.keyEnv]) throw new Error(`尚未设置 ${config.keyEnv}`);
  if (mode === 'desktop') {
    const permission = (await driver.run(['permissions'])) as {
      accessibility?: { state?: string };
      screen_recording?: { state?: string };
    };
    state['permissions'] = permission;
    publish();
    if (
      permission.accessibility?.state !== 'granted' ||
      permission.screen_recording?.state !== 'granted'
    )
      throw new Error('电脑任务需要系统辅助功能和屏幕录制权限。请点击“系统权限”，授权后刷新。');
  }
  const directory = join(dataRoot, 'artifacts/desktop', randomUUID());
  await mkdir(directory, { recursive: true });
  expanded = true;
  state['mode'] = mode;
  state['calls'] = 0;
  state['active'] = true;
  state['artifactDirectory'] = directory;
  state['desktopImage'] = '';
  state['model'] = config.model;
  state['startedAt'] = Date.now();
  events.length = 0;
  layout();
  message('user', instruction);
  status('running');
  const abort = new AbortController();
  let remaining = 600000;
  let resumedAt = Date.now();
  let timer = setTimeout(() => abort.abort(new Error('任务执行超时')), remaining);
  const control = new TaskControl((value) => {
    clearTimeout(timer);
    if (state['status'] === 'running') remaining -= Date.now() - resumedAt;
    if (value === 'running') {
      resumedAt = Date.now();
      timer = setTimeout(() => abort.abort(new Error('任务执行超时')), Math.max(1, remaining));
    } else pointer.hide();
    status(value);
  });
  const provider = new HttpModelProvider(config);
  const emit = async (event: Record<string, unknown>) => {
    const stamped = { ...event, at: new Date().toISOString() };
    await appendFile(join(directory, 'events.jsonl'), JSON.stringify(stamped) + '\n');
    if (event['type'] === 'model.usage') state['calls'] = event['callId'];
    if (event['type'] === 'handoff') message('assistant', String(event['summary']));
    const image = event['image'] as { data?: string } | undefined;
    if (mode === 'desktop' && image?.data)
      state['desktopImage'] = `data:image/png;base64,${image.data}`;
    const brief: Record<string, unknown> = {
      type: event['type'],
      turn: event['turn'],
      at: stamped.at,
    };
    if (event['action']) brief['action'] = event['action'];
    if (event['status']) brief['status'] = event['status'];
    if (event['summary']) brief['summary'] = event['summary'];
    events.push(brief);
    if (events.length > 150) events.shift();
    publish();
  };
  const model = new ModelGateway(
    provider,
    { maxCalls: settings.maxTurns, maxCostUsd: 3, maxConcurrent: 1, timeoutMs: config.timeoutMs },
    async (record) => emit({ type: 'model.usage', ...record }),
  );
  const finished = (async () => {
    try {
      let result;
      if (mode === 'browser') {
        const target =
          url?.trim() ||
          (/^https?:/.test(page.url()) ? page.url() : instruction.match(/https?:\/\/[^\s]+/)?.[0]);
        if (!target) throw new Error('请在浏览器地址栏输入网址，或在任务中写明目标网址');
        const normalized = normalizeUrl(target);
        const navigate = normalized !== page.url();
        result = await executeTask({
          page,
          model,
          task: instruction,
          url: normalized,
          navigate,
          allowCrossOrigin: true,
          control,
          signal: abort.signal,
          maxTurns: settings.maxTurns,
          actionTimeoutMs: 10000,
          maxOutputTokens: config.maxOutputTokens,
          vision: settings.vision,
          emit,
          onPointer: async (point) => {
            const bounds = view.getBounds();
            const content = window.getContentBounds();
            await pointer.show({
              x: content.x + bounds.x + point.x,
              y: content.y + bounds.y + point.y,
              clicking: point.clicking,
            });
          },
        });
        await page
          .screenshot({ path: join(directory, 'final.png'), timeout: 3000 })
          .catch(() => {});
      } else
        result = await executeComputerTask({
          task: instruction,
          model,
          driver,
          directory,
          signal: abort.signal,
          control,
          maxTurns: settings.maxTurns,
          maxOutputTokens: config.maxOutputTokens,
          emit,
          pointer: (point) => pointer.show(point, true),
          hidePointer: () => pointer.hide(),
        });
      await writeJson(join(directory, 'result.json'), {
        ...result,
        completionSource: 'model',
        usage: model.summary(),
      });
      message('assistant', result.summary);
      status(result.status === 'done' ? 'done' : 'blocked');
    } catch (error) {
      const info = errorInfo(abort.signal.aborted ? abort.signal.reason : error);
      await writeJson(join(directory, 'result.json'), {
        status: abort.signal.aborted ? 'cancelled' : 'error',
        error: info,
        usage: model.summary(),
      });
      message('assistant', info.message);
      status(abort.signal.aborted ? 'cancelled' : 'error');
    } finally {
      clearTimeout(timer);
      pointer.hide();
      await session
        .fromPartition('persist:flowprobe-browser')
        .cookies.flushStore()
        .catch(() => {});
      await provider.close();
      task = undefined;
      state['active'] = false;
      publish();
    }
  })();
  task = { abort, control, finished };
}

async function boot() {
  // Finder-launched applications do not necessarily inherit the login shell environment.
  if (process.platform === 'darwin' && !process.env['OPENAI_API_KEY']) {
    try {
      const { stdout } = await promisify(execFile)(
        '/bin/zsh',
        ['-lic', 'printenv OPENAI_API_KEY'],
        {
          timeout: 3000,
          maxBuffer: 65536,
        },
      );
      const key = stdout.trim().split('\n').at(-1)?.trim();
      if (key) process.env['OPENAI_API_KEY'] = key;
    } catch {}
  }
  try {
    const parsed = JSON.parse(await readFile(settingsFile, 'utf8'));
    settings = z
      .object({
        model: z.string().min(1).max(100),
        baseUrl: z.url(),
        maxTurns: z.number().int().min(1).max(200),
        vision: z.boolean(),
        theme: z.enum(['light', 'dark']).default('dark'),
      })
      .strict()
      .parse(parsed);
  } catch {}
  state['settings'] = settings;
  state['model'] = settings.model;
  state['hasKey'] = Boolean(process.env['OPENAI_API_KEY']);
  if (process.platform === 'darwin')
    app.dock?.setIcon(nativeImage.createFromPath(join(root, 'assets/icon.png')));
  try {
    const saved = JSON.parse(await readFile(historyFile, 'utf8')) as {
      messages?: Record<string, unknown>[];
      lastUrl?: string;
      artifactDirectory?: string;
    };
    if (Array.isArray(saved.messages)) messages.push(...saved.messages.slice(-100));
    if (saved.lastUrl && /^https?:/.test(saved.lastUrl)) state['lastUrl'] = saved.lastUrl;
    if (saved.artifactDirectory) state['artifactDirectory'] = saved.artifactDirectory;
  } catch {}
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'FlowProbe',
    icon: join(root, 'assets/icon.png'),
    backgroundColor: '#101214',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  view = new WebContentsView({
    webPreferences: {
      partition: 'persist:flowprobe-browser',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.contentView.addChildView(view);
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(({ url }) => ({
    action: /^https?:/.test(url) ? 'allow' : 'deny',
    overrideBrowserWindowOptions: {
      parent: window,
      width: 960,
      height: 760,
      webPreferences: {
        partition: 'persist:flowprobe-browser',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    },
  }));
  view.webContents.on('did-create-window', (popup) => {
    popup.setMenu(null);
    popup.on('closed', () => {
      if (!window.isDestroyed()) {
        view.webContents.focus();
        publish();
      }
    });
  });
  const updatePage = () => {
    state['url'] = view.webContents.getURL();
    state['title'] = view.webContents.getTitle();
    if (/^https?:/.test(String(state['url']))) saveHistory();
    publish();
  };
  view.webContents.on('did-navigate', updatePage);
  view.webContents.on('did-navigate-in-page', updatePage);
  view.webContents.on('page-title-updated', updatePage);
  view.webContents.on('did-stop-loading', updatePage);
  window.on('resize', layout);
  window.on('closed', () => {
    saveHistory();
    task?.abort.abort(new Error('客户端已关闭'));
    view.webContents.close();
    pointer?.close();
  });
  pointer = new DesktopPointer();
  ipcMain.handle('flowprobe:command', async (event, input: unknown) => {
    if (event.sender !== window.webContents) throw new Error('Untrusted IPC sender');
    try {
      const command = inputSchema.parse(input);
      switch (command.type) {
        case 'state':
          break;
        case 'settings-visible':
          settingsVisible = command.visible;
          layout();
          break;
        case 'save-settings': {
          if (task) throw new Error('请在任务结束后修改设置');
          const parsed = new URL(command.baseUrl);
          if (
            parsed.username ||
            parsed.password ||
            (parsed.protocol !== 'https:' &&
              !(
                parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)
              ))
          )
            throw new Error('模型地址需要 HTTPS 或本机 HTTP，且不能包含凭据');
          settings = {
            model: command.model,
            baseUrl: command.baseUrl,
            maxTurns: command.maxTurns,
            vision: command.vision,
            theme: command.theme,
          };
          await writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
          state['settings'] = settings;
          state['model'] = settings.model;
          state['hasKey'] = Boolean(process.env['OPENAI_API_KEY']);
          publish();
          break;
        }
        case 'run':
          await startTask(command.task, command.mode, command.url);
          break;
        case 'open':
          await openPage(command.url);
          break;
        case 'pause':
          if (task) await task.control.pause();
          break;
        case 'resume':
          task?.control.resume();
          break;
        case 'stop':
          task?.abort.abort(new Error('用户停止了任务'));
          break;
        case 'toggle-browser':
          expanded = !expanded;
          layout();
          break;
        case 'back':
          if (task) await task.control.pause();
          if (view.webContents.navigationHistory.canGoBack())
            view.webContents.navigationHistory.goBack();
          break;
        case 'forward':
          if (task) await task.control.pause();
          if (view.webContents.navigationHistory.canGoForward())
            view.webContents.navigationHistory.goForward();
          break;
        case 'reload':
          if (task) await task.control.pause();
          view.webContents.reload();
          break;
        case 'permissions':
          if (task) await task.control.pause();
          await driver.run(['permissions', '--guide']);
          await refreshPermissions();
          break;
        case 'refresh-permissions':
          await refreshPermissions();
          break;
        case 'show-driver':
          if (task) await task.control.pause();
          shell.showItemInFolder(
            process.platform === 'darwin' ? driver.application : driver.binary,
          );
          break;
        case 'quick-permission':
          if (task) await task.control.pause();
          if (process.platform !== 'darwin') throw new Error('快速添加当前用于 macOS 系统权限');
          await clipboard.writeText(driver.application);
          await shell.openExternal(
            `x-apple.systempreferences:com.apple.preference.security?${command.permission === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'}`,
          );
          shell.showItemInFolder(driver.application);
          state['permissionHelp'] = command.permission;
          publish();
          break;
        case 'show-client':
          if (task) await task.control.pause();
          shell.showItemInFolder(dirname(dirname(dirname(process.execPath))));
          break;
        case 'artifacts':
          if (state['artifactDirectory']) await shell.openPath(String(state['artifactDirectory']));
          break;
      }
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: errorInfo(error).message };
    }
  });
  globalShortcut.register('CommandOrControl+Shift+.', () =>
    task?.abort.abort(new Error('快捷键停止了任务')),
  );
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
  await window.loadFile(join(here, 'ui/index.html'));
  await view.webContents.loadURL('about:blank#flowprobe-browser');
  layout();
  try {
    await connectBrowser();
    ready = true;
    state['ready'] = true;
  } catch (error) {
    message('assistant', errorInfo(error).message);
    status('error');
  }
  await refreshPermissions();
  publish();
}
void app
  .whenReady()
  .then(boot)
  .catch((error) => {
    console.error(errorInfo(error));
    app.exit(1);
  });
