import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile, chmod, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('agent-desktop/package.json'));
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const base = resolve('.flowprobe/native-driver');
  const bundle = join(base, 'FlowProbe Driver.app');
  const executable = `agent-desktop-darwin-${process.arch}`;
  const key = `${metadata.version}-${process.arch}-bundle-1`;
  let prepared = false;
  try {
    prepared = (await readFile(join(base, 'version'), 'utf8')) === key;
    await access(join(bundle, 'Contents/MacOS', executable));
  } catch {
    prepared = false;
  }
  if (!prepared) {
    const binaries = join(bundle, 'Contents/MacOS');
    await mkdir(binaries, { recursive: true });
    for (const name of [executable, 'agent-desktop-macos-helper']) {
      await copyFile(join(directory, 'bin', name), join(binaries, name));
      await chmod(join(binaries, name), 0o755);
    }
    await writeFile(
      join(bundle, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.flowprobe.driver</string>
<key>CFBundleName</key><string>FlowProbe Driver</string>
<key>CFBundleDisplayName</key><string>FlowProbe Driver</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppleEventsUsageDescription</key><string>根据你下达的任务操作桌面应用。</string>
</dict></plist>`,
    );
    execFileSync(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    await writeFile(join(base, 'version'), key);
  }
}
