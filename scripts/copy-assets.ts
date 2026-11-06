import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/examples/simulator', { recursive: true });
await copyFile('examples/simulator/index.html', 'dist/examples/simulator/index.html');
