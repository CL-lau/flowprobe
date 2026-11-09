import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';

async function launch(profile: string, config: string): Promise<ElectronApplication> {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return electron.launch({
    args: [resolve('dist/desktop/main.js')],
    timeout: 30000,
    env: {
      ...process.env,
      FLOWPROBE_PROFILE: profile,
      FLOWPROBE_CDP_PORT: String(port),
      FLOWPROBE_MODEL_CONFIG: config,
      OPENAI_API_KEY: 'fixture-key',
    },
  });
}

test(
  'desktop browser sidebar supports manual login, resume and persistent session',
  { timeout: 90000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'flowprobe-desktop-'));
    let calls = 0;
    const server = createServer(async (req, res) => {
      if (req.url === '/model') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        calls++;
        const snapshot = body.input.observation.snapshot as string;
        const output = snapshot.includes('登录验证')
          ? { status: 'handoff', summary: '请在右侧完成登录，然后点击继续执行' }
          : snapshot.includes('操作成功')
            ? { status: 'done', summary: '已登录，并完成受保护页面中的任务' }
            : {
                status: 'act',
                actions: [{ type: 'click', target: { role: 'button', name: '完成任务' } }],
              };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            output,
            model: 'fixture',
            usage: { inputTokens: 20, outputTokens: 20, costUsd: 0.001 },
          }),
        );
        return;
      }
      if (req.url === '/session') {
        res.setHeader(
          'Set-Cookie',
          'flowprobe_login=yes; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
        );
        res.end('ok');
        return;
      }
      if (req.url === '/app' && !req.headers.cookie?.includes('flowprobe_login=yes')) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/html;charset=utf-8');
      if (req.url === '/login')
        res.end(
          `<html><body><h1>登录验证</h1><label>用户名<input id="user"></label><label>密码<input id="password" type="password"></label><button onclick="fetch('/session',{method:'POST'}).then(()=>location.href='/app')">登录</button></body></html>`,
        );
      else
        res.end(
          `<html><body><h1>已登录的工作台</h1><button onclick="document.getElementById('result').textContent='操作成功'">完成任务</button><p id="result" role="status"></p></body></html>`,
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const profile = join(temporary, 'profile');
    const config = join(temporary, 'model.json');
    await writeFile(
      config,
      JSON.stringify({
        protocol: 'gateway',
        endpoint: url + '/model',
        model: 'fixture',
        maxCostPerCallUsd: 0.01,
      }),
    );
    let app: ElectronApplication | undefined;
    try {
      app = await launch(profile, config);
      const ui = await app.firstWindow();
      ui.on('console', (message) => {
        if (message.type() === 'error') console.error('renderer:', message.text());
      });
      await ui.waitForFunction(
        () => {
          const button = document.querySelector('#run') as HTMLButtonElement | null;
          return button !== null && !button.disabled;
        },
        {},
        { timeout: 30000 },
      );
      await ui.locator('#toggle').click();
      await ui.locator('#url').fill(url + '/app');
      await ui.locator('#task').fill('在工作台中点击完成任务，确认操作成功；需要登录时请交给我');
      await ui.locator('#run').click();
      await expect(ui.locator('#handoff')).toBeVisible({ timeout: 20000 });
      const content = app
        .context()
        .pages()
        .find((page) => page.url().endsWith('/login'));
      assert.ok(content, 'embedded browser page exists');
      const countAtHandoff = calls;
      await content.getByLabel('用户名').fill('manual-user');
      await content.getByLabel('密码').fill('private-login-only');
      await content.getByRole('button', { name: '登录', exact: true }).click();
      await expect(content.getByRole('heading')).toHaveText('已登录的工作台');
      assert.equal(calls, countAtHandoff, 'model pauses during manual login');
      await ui.locator('#resume').click();
      await expect(ui.locator('#status')).toHaveText('任务已完成', { timeout: 20000 });
      await expect(content.getByRole('status')).toHaveText('操作成功');
      await expect(ui.locator('#run')).toBeEnabled();
      await mkdir('artifacts/desktop-verification', { recursive: true });
      await ui.screenshot({ path: 'artifacts/desktop-verification/client.png' });
      await content.screenshot({ path: 'artifacts/desktop-verification/browser.png' });
      const directory = await ui.evaluate(async () => {
        const api = (
          window as unknown as {
            flowprobe: {
              command: (input: unknown) => Promise<{ state: { artifactDirectory: string } }>;
            };
          }
        ).flowprobe;
        return (await api.command({ type: 'state' })).state.artifactDirectory;
      });
      const events = await readFile(join(directory, 'events.jsonl'), 'utf8');
      assert.ok(
        !events.includes('private-login-only'),
        'manual credentials never enter task observations',
      );
      await app.close();
      app = undefined;
      app = await launch(profile, config);
      const reopened = await app.firstWindow();
      await reopened.waitForFunction(
        () => {
          const button = document.querySelector('#run') as HTMLButtonElement | null;
          return button !== null && !button.disabled;
        },
        {},
        { timeout: 30000 },
      );
      await reopened.locator('#toggle').click();
      await reopened.locator('#url').fill(url + '/app');
      await reopened.locator('#open').click();
      const pages = app.context().pages();
      const persisted = pages.find(
        (page) =>
          page.url().includes('#flowprobe-browser') ||
          page.url().endsWith('/app') ||
          page.url().endsWith('/login'),
      );
      assert.ok(
        persisted,
        'login cookie survives client restart: ' + JSON.stringify(pages.map((page) => page.url())),
      );
      await expect(persisted).toHaveURL(url + '/app');
      await expect(persisted.getByRole('heading')).toHaveText('已登录的工作台');
      await writeFile(
        'artifacts/desktop-verification/result.json',
        JSON.stringify(
          {
            passed: true,
            modelCalls: calls,
            manualLogin: true,
            noCredentialCapture: true,
            persistentSession: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test(
  'settings save and reload without exposing stored credentials',
  { timeout: 60000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'flowprobe-settings-'));
    const profile = join(temporary, 'profile');
    const config = join(temporary, 'model.json');
    await writeFile(
      config,
      JSON.stringify({
        protocol: 'gateway',
        endpoint: 'http://127.0.0.1:1/model',
        model: 'fixture',
        maxCostPerCallUsd: 0.01,
      }),
    );
    let app: ElectronApplication | undefined;
    try {
      app = await launch(profile, config);
      let ui = await app.firstWindow();
      await ui.waitForFunction(
        () => {
          const button = document.querySelector('#run') as HTMLButtonElement | null;
          return button !== null && !button.disabled;
        },
        {},
        { timeout: 30000 },
      );
      await ui.locator('#settings-open').click();
      await ui.locator('#setting-model').fill('custom-model');
      await ui.locator('#setting-base').fill('https://example.com/v1');
      await ui.locator('#setting-turns').fill('12');
      await ui.locator('#setting-vision').uncheck();
      await ui.locator('#setting-theme').selectOption('light');
      await ui.getByRole('button', { name: '保存设置' }).click();
      await expect(ui.locator('#settings-panel')).toBeHidden();
      await app.close();
      app = undefined;
      app = await launch(profile, config);
      ui = await app.firstWindow();
      await ui.waitForFunction(
        () => {
          const button = document.querySelector('#run') as HTMLButtonElement | null;
          return button !== null && !button.disabled;
        },
        {},
        { timeout: 30000 },
      );
      await ui.locator('#settings-open').click();
      await expect(ui.locator('#setting-model')).toHaveValue('custom-model');
      await expect(ui.locator('#setting-base')).toHaveValue('https://example.com/v1');
      await expect(ui.locator('#setting-turns')).toHaveValue('12');
      await expect(ui.locator('#setting-vision')).not.toBeChecked();
      await expect(ui.locator('#setting-theme')).toHaveValue('light');
      await expect(ui.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await app?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
