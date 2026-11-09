import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
if (process.platform !== 'darwin') throw new Error('DMG packaging requires macOS');
const require = createRequire(import.meta.url);
const electron = require('electron');
const electronApp = electron.slice(0, electron.indexOf('/Contents/MacOS/'));
const staging = resolve('build/dmg-stage');
const app = join(staging, 'FlowProbe.app');
const resources = join(app, 'Contents/Resources');
const appDir = join(resources, 'app');
const dmg = resolve(`release/FlowProbe-${process.arch}.dmg`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync('release', { recursive: true });
execFileSync('/usr/bin/ditto', [electronApp, app]);
mkdirSync(appDir, { recursive: true });
for (const name of ['dist', 'assets'])
  execFileSync('/usr/bin/ditto', [resolve(name), join(appDir, name)]);
copyFileSync('package.json', join(appDir, 'package.json'));
execFileSync('/usr/bin/rsync', [
  '-a',
  '--exclude=electron/dist',
  '--exclude=.cache',
  `${resolve('node_modules')}/`,
  join(appDir, 'node_modules/'),
]);
execFileSync('/usr/bin/ditto', [
  resolve('.flowprobe/native-driver'),
  join(resources, 'native-driver'),
]);
writeFileSync(join(resources, 'flowprobe-packaged'), '1');
copyFileSync('build/icon.icns', join(resources, 'FlowProbe.icns'));
const plist = join(app, 'Contents/Info.plist');
for (const [key, value] of [
  ['CFBundleName', 'FlowProbe'],
  ['CFBundleDisplayName', 'FlowProbe'],
  ['CFBundleIdentifier', 'dev.flowprobe.desktop'],
  ['CFBundleIconFile', 'FlowProbe.icns'],
  ['CFBundleShortVersionString', '0.2.0'],
])
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], {
  stdio: 'inherit',
});
execFileSync('/bin/ln', ['-s', '/Applications', join(staging, 'Applications')]);
if (existsSync(dmg)) rmSync(dmg);
execFileSync(
  '/usr/bin/hdiutil',
  ['create', '-volname', 'FlowProbe', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg],
  { stdio: 'inherit' },
);
console.log(`DMG: ${dmg}`);
