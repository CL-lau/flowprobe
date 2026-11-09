import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
const temp = await mkdtemp(join(tmpdir(), 'flowprobe-dmg-'));
const mount = join(temp, 'mount');
await mkdir(mount);
let browserRequests = 0;
const server = createServer((_request, response) => {
  browserRequests++;
  response.setHeader('content-type', 'text/html');
  response.end('<h1>DMG browser verified</h1>');
});
let child,
  browser,
  mounted = false;
try {
  execFileSync(
    '/usr/bin/hdiutil',
    [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mount,
      resolve(`release/FlowProbe-${process.arch}.dmg`),
    ],
    { stdio: 'ignore' },
  );
  mounted = true;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serverAddress = server.address();
  const cdpServer = createServer();
  cdpServer.listen(0, '127.0.0.1');
  await once(cdpServer, 'listening');
  const port = cdpServer.address().port;
  await new Promise((resolve) => cdpServer.close(resolve));
  child = spawn(join(mount, 'FlowProbe.app/Contents/MacOS/Electron'), [], {
    env: {
      ...process.env,
      FLOWPROBE_PROFILE: join(temp, 'profile'),
      FLOWPROBE_CDP_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!browser) throw new Error(`Packaged browser did not start: ${errors.slice(-1500)}`);
  let ui;
  for (let i = 0; i < 100; i++) {
    ui = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('/desktop/ui/index.html'));
    if (ui) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ui) throw new Error('Packaged client UI missing');
  await ui.waitForFunction(() => !document.querySelector('#run').disabled, null, {
    timeout: 30000,
  });
  if (
    !(await ui
      .locator('.brand-image')
      .evaluate((image) => image.complete && image.naturalWidth > 0))
  )
    throw new Error('Packaged application icon did not load');
  await ui.locator('#settings-open').click();
  await ui.locator('#setting-model').fill('dmg-test-model');
  await ui.getByRole('button', { name: '保存设置' }).click();
  await ui.locator('#settings-open').click();
  if ((await ui.locator('#setting-model').inputValue()) !== 'dmg-test-model')
    throw new Error('Packaged settings not saved');
  await mkdir('artifacts/dmg-verification', { recursive: true });
  await ui.screenshot({ path: 'artifacts/dmg-verification/settings.png' });
  await ui.locator('#settings-close').click();
  await ui.locator('#toggle').click();
  await ui.locator('#url').fill(`http://127.0.0.1:${serverAddress.port}`);
  await ui.locator('#open').click();
  for (let i = 0; i < 100 && browserRequests === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!browserRequests) throw new Error('Packaged browser did not request the page');
  await ui.waitForFunction(
    (port) => document.querySelector('#url').value === `http://127.0.0.1:${port}/`,
    serverAddress.port,
    { timeout: 10000 },
  );
  await mkdir('artifacts/dmg-verification', { recursive: true });
  await ui.screenshot({ path: 'artifacts/dmg-verification/client.png' });
  console.log('DMG application launched; settings saved; browser opened.');
  if (process.env.FLOWPROBE_DMG_LIVE === '1') {
    const result = await ui.evaluate(async () => {
      const saved = await window.flowprobe.command({
        type: 'save-settings',
        model: 'gpt-6-luna',
        baseUrl: 'https://api.openai.com/v1',
        maxTurns: 15,
        vision: true,
      });
      if (!saved.ok) return saved;
      return window.flowprobe.command({
        type: 'run',
        mode: 'browser',
        url: 'https://www.selenium.dev/selenium/web/web-form.html',
        task: '将 Text input 填为 FlowProbe DMG，提交表单，并确认结果页出现 Form submitted 和 Received!。',
      });
    });
    if (!result.ok) throw new Error('Packaged live task did not start: ' + result.error);
    await ui.waitForFunction(
      () => document.querySelector('#status').textContent === '任务已完成',
      null,
      { timeout: 180000 },
    );
    console.log('Packaged gpt-6-luna browser task completed successfully.');
  }
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit').catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' });
  await rm(temp, { recursive: true, force: true });
}
