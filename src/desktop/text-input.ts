import { clipboard, ClipboardItem } from 'electron';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeDesktop } from './native.js';

/** Focused typing for inaccessible controls; snapshots and restores all clipboard formats. */
export async function typeFocusedText(driver: NativeDesktop, text: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const saved = await Promise.all(
    (await clipboard.read()).map(
      async (item) =>
        new ClipboardItem(
          Object.fromEntries(
            await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
          ),
        ),
    ),
  );
  const marker = randomUUID();
  const format = 'web application/x.flowprobe-paste';
  try {
    await clipboard.write([
      new ClipboardItem({ 'text/plain': text, [format]: new Blob([marker]) }),
    ]);
    await driver.run(
      ['--headed', 'press', process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v'],
      signal,
    );
    // Paste is consumed on the target app's next event loop turn after native key delivery.
    await delay(150, undefined, { signal });
  } finally {
    // Do not overwrite anything the user copied while the native input was being delivered.
    const current = (await clipboard.read()).find((item) => item.types.includes(format));
    if (current && (await (await current.getType(format)).text()) === marker) {
      if (saved.length) await clipboard.write(saved);
      else clipboard.clear();
    }
  }
}
