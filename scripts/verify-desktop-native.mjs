import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const endpoint = process.env.FLOWPROBE_DESKTOP_CDP || 'http://127.0.0.1:56563';
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(`<!doctype html><html lang="zh"><head><title>FlowProbe Desktop 验证窗口</title>
<style>body{background:#edf4f0;font:22px system-ui;padding:90px;color:#17352a}main{background:white;border:1px solid #c8d9d0;border-radius:20px;max-width:700px;padding:40px}h1{font-size:30px}p{color:#5c7468;line-height:1.8}input{display:block;margin:20px 0;padding:15px;font:24px system-ui;width:500px;border:2px solid #779d89;border-radius:8px}button{background:#1c6a4c;color:white;padding:14px 40px;border:0;border-radius:8px;font-size:22px}#result{font-weight:bold;color:#167c4f}</style></head>
<body><main><h1>FlowProbe Desktop 验证窗口</h1><p>这是临时输入测试。请在下方输入框填写指定字符串，按 Tab，再按 Enter。</p>
<form onsubmit="event.preventDefault();document.getElementById('result').textContent=document.getElementById('value').value==='FlowProbe-native'?'验证成功：FlowProbe-native':'内容不匹配';"><label for="value">验证内容</label><input id="value" autocomplete="off"><button type="submit">验证</button></form><p id="result" role="status"></p></main></body></html>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
let connection;
let target;
let ui;
let completed = false;
let started = false;
let ownArtifactDirectory;
try {
  connection = await chromium.connectOverCDP(endpoint);
  ui = connection
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes('/desktop/ui/index.html'));
  if (!ui) throw new Error('FlowProbe 客户端未启动');
  const initial = await ui.evaluate(() =>
    window.flowprobe.command({ type: 'refresh-permissions' }),
  );
  if (initial.state?.active) throw new Error('请等待当前任务完成后再运行验证');
  if (
    initial.state?.permissions?.accessibility?.state !== 'granted' ||
    initial.state?.permissions?.screen_recording?.state !== 'granted'
  )
    throw new Error('驱动尚未获得两项系统权限');
  target = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--window-position=20,50', '--window-size=1400,850'],
  });
  const page = await target.newPage();
  await page.goto(url);
  await page.bringToFront();
  const result = await ui.evaluate(
    (task) => window.flowprobe.command({ type: 'run', mode: 'desktop', task }),
    '只在当前已经打开的“FlowProbe Desktop 验证窗口”中操作：先用鼠标点击“验证内容”输入框，输入准确字符串 FlowProbe-native，然后按 Tab 将焦点移到“验证”按钮，再按 Enter 提交。不要改用鼠标点击验证按钮。确认页面明确显示“验证成功：FlowProbe-native”后报告完成。不要操作其他窗口或系统设置。这是一个无外部副作用的临时测试页面。',
  );
  if (!result.ok) throw new Error(result.error);
  started = true;
  ownArtifactDirectory = result.state.artifactDirectory;
  await page.bringToFront();
  const deadline = Date.now() + 180000;
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 500));
    state = (await ui.evaluate(() => window.flowprobe.command({ type: 'state' }))).state;
    if (state.status === 'manual') throw new Error('电脑测试要求人工接管，未自动完成');
  } while (state.active && Date.now() < deadline);
  if (state.active) throw new Error('电脑测试超时');
  if (state.status !== 'done')
    throw new Error('电脑任务未完成：' + JSON.stringify(state.messages?.at(-1)));
  await expect(page.getByRole('status')).toHaveText('验证成功：FlowProbe-native');
  const events = (await readFile(join(state.artifactDirectory, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const actions = events.filter((event) => event.type === 'action').map((event) => event.action);
  if (
    !actions.some((action) => action.type === 'click') ||
    !actions.some((action) => action.type === 'type') ||
    actions.filter((action) => action.type === 'press').length < 2
  )
    throw new Error('缺少实际鼠标、文字或键盘操作证据');
  await mkdir('artifacts/desktop-native-verification', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-native-verification/result.png' });
  await writeFile(
    'artifacts/desktop-native-verification/validation.json',
    JSON.stringify(
      {
        passed: true,
        model: state.model,
        artifactDirectory: state.artifactDirectory,
        modelCalls: state.calls,
        actions,
        actualText: await page.getByRole('status').innerText(),
      },
      null,
      2,
    ),
  );
  completed = true;
  console.log(
    JSON.stringify({
      passed: true,
      model: state.model,
      calls: state.calls,
      actions: actions.map((action) => action.type),
      artifactDirectory: state.artifactDirectory,
    }),
  );
} finally {
  if (!completed && started && ui) {
    const live = await ui
      .evaluate(() => window.flowprobe.command({ type: 'state' }))
      .catch(() => null);
    if (live?.state?.active && live.state.artifactDirectory === ownArtifactDirectory)
      await ui.evaluate(() => window.flowprobe.command({ type: 'stop' })).catch(() => {});
  }
  await target?.close();
  await connection?.close();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
