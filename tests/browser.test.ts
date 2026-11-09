import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { executeTask, decisionSchema } from '../src/task.js';
import { gatewayConfigSchema, HttpModelProvider } from '../src/model.js';
import { createPreview } from '../src/preview.js';

const channel = process.env['FLOWPROBE_TEST_CHANNEL'];
const launch = () => chromium.launch(channel ? { channel } : {});
const html = `<!doctype html><html lang="zh"><body>
<label>姓名<input id="name"></label><label>邮箱<input id="email"></label>
<button onclick="document.querySelector('#result').textContent='已保存：'+document.querySelector('#name').value+' '+document.querySelector('#email').value">保存</button>
<div id="result" role="status"></div>
<canvas data-testid="drawing" width="200" height="100" onclick="document.querySelector('#result').textContent='画布已点击'"></canvas></body></html>`;

async function fixture() {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push({ ...body, authenticated: req.headers.authorization === 'Bearer fixture-key' });
      let input: { observation: { snapshot: string } };
      if (body['messages']) {
        const messages = body['messages'] as { content: string }[];
        input = JSON.parse(messages[1]!.content).input as typeof input;
      } else input = body['input'] as typeof input;
      const output = input.observation.snapshot.includes('已保存：小明')
        ? { status: 'done', summary: '页面显示已保存：小明 ming@example.test' }
        : {
            status: 'act',
            actions: [
              { type: 'fill', target: { label: '姓名' }, value: '小明' },
              { type: 'fill', target: { label: '邮箱' }, value: 'ming@example.test' },
              { type: 'click', target: { role: 'button', name: '保存' } },
            ],
          };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          body['messages']
            ? {
                model: 'fixture',
                choices: [{ message: { content: JSON.stringify(output) } }],
                usage: { prompt_tokens: 10, completion_tokens: 20 },
              }
            : {
                model: 'fixture',
                output,
                usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
              },
        ),
      );
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}

test('direct CLI task executes real browser actions through chat-completions and gateway', async () => {
  const site = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'flowprobe-task-'));
  try {
    for (const protocol of ['chat-completions', 'gateway', 'environment']) {
      const config = join(directory, `${protocol}.json`);
      await writeFile(
        config,
        JSON.stringify({
          endpoint: `${site.url}/model`,
          model: 'fixture',
          protocol: protocol === 'environment' ? 'chat-completions' : protocol,
          maxCostPerCallUsd: 0.01,
        }),
      );
      const output = join(directory, protocol);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          resolve('node_modules/tsx/dist/cli.mjs'),
          'src/cli.ts',
          'task',
          ...(process.env['FLOWPROBE_TEST_HEADED'] === '1' ? ['--keep-open', '0'] : ['--headless']),
          '--url',
          site.url,
          '--task',
          '填写姓名小明和邮箱 ming@example.test，保存',
          ...(protocol === 'environment' ? [] : ['--model-config', config]),
          '--output',
          output,
          ...(channel ? ['--channel', channel] : []),
        ],
        {
          timeout: 30000,
          env: {
            ...process.env,
            OPENAI_MODEL: 'fixture',
            OPENAI_API_KEY: 'fixture-key',
            OPENAI_BASE_URL: site.url,
          },
        },
      );
      assert.match(stdout, /done:/);
      const artifactDirectory = stdout.match(/Task artifacts: (.+)/)![1]!;
      const result = JSON.parse(await readFile(join(artifactDirectory, 'result.json'), 'utf8'));
      assert.equal(result.status, 'done');
      assert.equal(result.turns, 2);
      assert.equal(result.usage.calls, 2);
      if (protocol !== 'gateway') {
        assert.equal(site.requests.at(-1)!['max_completion_tokens'], 4096);
        assert.equal(site.requests.at(-1)!['max_tokens'], undefined);
      }
      if (protocol === 'environment') assert.equal(site.requests.at(-1)!['authenticated'], true);
      const events = (await readFile(join(artifactDirectory, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events.filter((event) => event.type === 'action').length, 3);
      assert.ok(
        events.some(
          (event) =>
            event.type === 'observation' &&
            event.snapshot.includes('已保存：小明 ming@example.test'),
        ),
      );
      assert.ok((await readFile(join(artifactDirectory, 'final.png'))).byteLength > 100);
      assert.ok((await readFile(join(artifactDirectory, 'trace.zip'))).byteLength > 100);
    }
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('click ends a batch, turn limit blocks, and cancellation stops before navigation', async () => {
  const site = await fixture();
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const events: Record<string, unknown>[] = [];
    const controller = new AbortController();
    const options = {
      page,
      url: site.url,
      task: '保存',
      signal: controller.signal,
      maxTurns: 1,
      actionTimeoutMs: 2000,
      maxOutputTokens: 1000,
      emit: async (event: Record<string, unknown>) => {
        events.push(event);
      },
      model: {
        generate: async () => ({
          status: 'act',
          actions: [
            { type: 'click', target: { role: 'button', name: '保存' } },
            { type: 'fill', target: { label: '姓名' }, value: '不应该执行' },
          ],
        }),
      },
    };
    const result = await executeTask(options);
    assert.equal(result.status, 'blocked');
    assert.equal(await page.getByLabel('姓名').inputValue(), '');
    assert.equal(events.filter((event) => event.type === 'action').length, 1);
    controller.abort(new Error('cancelled'));
    await assert.rejects(executeTask(options), /cancelled/);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('action failures stop without automatic resubmission', async () => {
  const site = await fixture();
  const browser = await launch();
  try {
    let calls = 0;
    await assert.rejects(
      executeTask({
        page: await browser.newPage(),
        url: site.url,
        task: '保存',
        signal: new AbortController().signal,
        maxTurns: 3,
        actionTimeoutMs: 200,
        maxOutputTokens: 1000,
        emit: async () => {},
        model: {
          generate: async () => {
            calls++;
            return {
              status: 'act',
              actions: [{ type: 'click', target: { role: 'button', name: '不存在' } }],
            };
          },
        },
      }),
      /Timeout/,
    );
    assert.equal(calls, 1);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('vision supplies viewport screenshot and point actions require it', async () => {
  const site = await fixture();
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await executeTask({
      page,
      url: site.url,
      task: '观察页面',
      signal: new AbortController().signal,
      maxTurns: 1,
      actionTimeoutMs: 2000,
      maxOutputTokens: 1000,
      vision: true,
      emit: async () => {},
      model: {
        generate: async (request) => {
          const input = request.input as {
            observation: { image: { data: string }; viewport: unknown };
          };
          assert.ok(Buffer.from(input.observation.image.data, 'base64').byteLength > 100);
          assert.ok(input.observation.viewport);
          return { status: 'done', summary: '已观察' };
        },
      },
    });
    await assert.rejects(
      executeTask({
        page,
        url: site.url,
        task: '点击',
        signal: new AbortController().signal,
        maxTurns: 1,
        actionTimeoutMs: 2000,
        maxOutputTokens: 1000,
        emit: async () => {},
        model: {
          generate: async () => ({
            status: 'act',
            actions: [
              {
                type: 'point',
                target: { css: 'body' },
                x: 0.5,
                y: 0.5,
                expectedSize: { width: 100, height: 100 },
              },
            ],
          }),
        },
      }),
      /require --vision/,
    );
  } finally {
    await browser.close();
    await site.close();
  }
});

test('schema rejects old framework actions and model endpoint credentials are validated', () => {
  assert.equal(
    decisionSchema.safeParse({ status: 'act', actions: [{ type: 'plugin', plugin: 'anything' }] })
      .success,
    false,
  );
  assert.throws(
    () =>
      new HttpModelProvider(
        gatewayConfigSchema.parse({
          endpoint: 'http://example.com/model',
          model: 'x',
          maxCostPerCallUsd: 0.01,
        }),
      ),
    /HTTPS/,
  );
});

test('preview survives navigation, stays out of DOM observations and does not block clicks', async () => {
  const site = await fixture();
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const preview = await createPreview(page);
    await page.goto(site.url);
    await page.addStyleTag({
      content:
        'body { padding:80px; background:#f1f5f9; font:18px system-ui; } label { display:block; margin:24px 0; } input { padding:12px; margin-left:16px; } button { padding:12px 40px; background:#2563eb; color:white; border:0; border-radius:8px; }',
    });
    const button = page.getByRole('button', { name: '保存', exact: true });
    await page.getByLabel('姓名').fill('小明');
    const box = await button.boundingBox();
    assert.ok(box);
    await preview({
      task: '填写姓名和邮箱，然后保存',
      message: '点击 保存',
      turn: 2,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      clicking: true,
    });
    assert.equal(await page.locator('[data-flowprobe-preview]').count(), 1);
    assert.equal(
      await page.locator('[data-flowprobe-preview]').getAttribute('aria-hidden'),
      'true',
    );
    assert.doesNotMatch(await page.locator('body').ariaSnapshot(), /FlowProbe|点击 保存/);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/preview.png' });
    await button.click();
    assert.match(await page.getByRole('status').innerText(), /已保存：小明/);
    await page.goto(`${site.url}/next`);
    assert.equal(await page.locator('[data-flowprobe-preview]').count(), 1);
    await preview({ task: '填写姓名和邮箱，然后保存', message: '已完成', turn: 3 });
  } finally {
    await browser.close();
    await site.close();
  }
});

test('visual task uses observed component geometry to click a real canvas', async () => {
  const site = await fixture();
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const result = await executeTask({
      page,
      url: site.url,
      task: '点击画布中心',
      signal: new AbortController().signal,
      maxTurns: 2,
      actionTimeoutMs: 2000,
      maxOutputTokens: 1000,
      vision: true,
      emit: async () => {},
      model: {
        generate: async (request) => {
          const observation = (
            request.input as {
              observation: {
                snapshot: string;
                visualTargets: {
                  target: { testId?: string };
                  box: { width: number; height: number };
                }[];
              };
            }
          ).observation;
          if (observation.snapshot.includes('画布已点击'))
            return { status: 'done', summary: '画布已点击' };
          const drawing = observation.visualTargets.find(
            (target) => target.target.testId === 'drawing',
          );
          assert.ok(drawing);
          return {
            status: 'act',
            actions: [
              {
                type: 'point',
                target: drawing.target,
                x: 0.5,
                y: 0.5,
                expectedSize: { width: drawing.box.width, height: drawing.box.height },
              },
            ],
          };
        },
      },
    });
    assert.equal(result.status, 'done');
    assert.equal(await page.getByRole('status').innerText(), '画布已点击');
  } finally {
    await browser.close();
    await site.close();
  }
});
