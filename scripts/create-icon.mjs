import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
if (process.platform !== 'darwin') process.exit(0);
mkdirSync('build/icon.iconset', { recursive: true });
execFileSync(
  '/usr/bin/sips',
  ['-s', 'format', 'png', 'assets/icon.svg', '--out', 'build/icon.png'],
  { stdio: 'ignore' },
);
for (const [size, name] of [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
])
  execFileSync(
    '/usr/bin/sips',
    ['-z', String(size), String(size), 'build/icon.png', '--out', `build/icon.iconset/${name}`],
    { stdio: 'ignore' },
  );
execFileSync('/usr/bin/iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns']);
