import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
await import('./install-electron.mjs');
const { default: electron } = await import('electron');
const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const env = { ...process.env, FLOWPROBE_CDP_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['dist/desktop/main.js', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
