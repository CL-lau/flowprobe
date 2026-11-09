import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

interface Order {
  id: string;
  title: string;
  amountMinor: number;
  status: string;
}
interface Session {
  orders: Order[];
  fault: string;
  role: string;
}
const sessions = new Map<string, Session>();
const faultProfiles = new Map<string, string>();
const clientFile = fileURLToPath(new URL('./web.ts', import.meta.url));
const client = import.meta.url.endsWith('.ts')
  ? (
      await transform(await readFile(clientFile, 'utf8'), {
        loader: 'ts',
        target: 'es2022',
        format: 'esm',
      })
    ).code
  : await readFile(new URL('./web.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let id = /(?:^|;\s*)fp=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!id || !sessions.has(id)) {
    id = randomUUID();
    sessions.set(id, { orders: [], fault: '', role: 'admin' });
    res.setHeader('Set-Cookie', `fp=${id}; HttpOnly; SameSite=Strict; Path=/`);
  }
  const state = sessions.get(id)!;
  if (url.searchParams.has('profile'))
    state.fault = faultProfiles.get(url.searchParams.get('profile')!) ?? '';
  if (url.searchParams.has('fault')) state.fault = url.searchParams.get('fault')!;
  if (url.searchParams.has('role')) state.role = url.searchParams.get('role')!;
  const json = (status: number, data: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  try {
    if (/^\/api\/fault-profiles\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      const profile = url.pathname.split('/').at(-1)!;
      if (req.method === 'DELETE') {
        faultProfiles.delete(profile);
        json(200, { deleted: true });
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += String(chunk);
          if (raw.length > 1024) {
            json(413, {});
            return;
          }
        }
        const input = JSON.parse(raw) as { fault: string };
        if (!['', 'wrong-amount', 'fake-success', 'server-error'].includes(input.fault)) {
          json(422, {});
          return;
        }
        faultProfiles.set(profile, input.fault);
        json(200, { configured: true });
        return;
      }
    }
    if (url.pathname === '/health') {
      json(200, { ready: true });
      return;
    }
    if (url.pathname === '/web.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(client);
      return;
    }
    if (url.pathname === '/api/session') {
      json(200, { role: state.role, fault: state.fault });
      return;
    }
    if (url.pathname === '/api/orders' && req.method === 'GET') {
      json(200, { orders: state.orders, total: state.orders.length });
      return;
    }
    if (url.pathname === '/api/orders' && req.method === 'POST') {
      if (state.role !== 'admin') {
        json(403, { error: '权限不足' });
        return;
      }
      let raw = '';
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 10000) {
          json(413, { error: 'Body too large' });
          return;
        }
      }
      const input = JSON.parse(raw) as { title?: unknown; amountMinor?: unknown };
      if (
        typeof input.title !== 'string' ||
        !input.title.trim() ||
        typeof input.amountMinor !== 'number' ||
        !Number.isInteger(input.amountMinor) ||
        input.amountMinor <= 0
      ) {
        json(422, { error: '标题和金额不能为空' });
        return;
      }
      if (state.fault === 'server-error') {
        json(500, { error: '仿真服务故障' });
        return;
      }
      const order: Order = {
        id: randomUUID(),
        title: input.title,
        amountMinor: state.fault === 'wrong-amount' ? 1 : input.amountMinor,
        status: '待审批',
      };
      if (state.fault !== 'fake-success') state.orders.push(order);
      json(201, order);
      return;
    }
    if (url.pathname === '/api/permission') {
      json(state.role === 'admin' ? 200 : 403, { canEdit: state.role === 'admin' });
      return;
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      state.orders = [];
      json(200, { reset: true });
      return;
    }
    if (url.pathname === '/embedded') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html lang="zh-CN"><label>审批意见 <input aria-label="审批意见"></label></html>');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json(404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    json(400, { error: 'Invalid request' });
  }
});
const port = Number(process.env['PORT'] ?? 4173);
server.listen(port, '127.0.0.1', () =>
  console.log(`FlowProbe simulator: http://127.0.0.1:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => server.close(() => process.exit(0)));
