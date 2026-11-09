import type { Page } from '@playwright/test';

export interface PreviewState {
  task: string;
  message: string;
  turn?: number;
  x?: number;
  y?: number;
  clicking?: boolean;
}

// This function is serialized into each new document; keep it self-contained.
function installPreview() {
  document.addEventListener('flowprobe:install', () => {
    if (document.querySelector('[data-flowprobe-preview]')) return;
    const host = document.createElement('div');
    host.setAttribute('data-flowprobe-preview', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host { all:initial; pointer-events:none; }
      .panel { position:fixed;top:12px;right:12px;max-width:340px;padding:12px 16px;
        color:#f8fafc;background:rgba(15,23,42,.92);border:1px solid #475569;border-radius:12px;
        box-shadow:0 4px 24px #0003;font:13px/1.6 system-ui,sans-serif;overflow-wrap:anywhere; }
      .title { font-weight:700;color:#93c5fd; } .task { color:#cbd5e1;max-height:64px;overflow:hidden; }
      .cursor { box-sizing:border-box;position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px;
        border:2px solid #fff;border-radius:50%;background:#2563ebaa;
        box-shadow:0 0 0 4px #2563eb55;display:none; }
      .cursor.click { background:#f97316bb;box-shadow:0 0 0 10px #f9731644; }
    </style><div class="panel"><div class="title">FlowProbe · 执行预览</div>
    <div class="task"></div><div class="message">正在打开页面</div></div><div class="cursor"></div>`;
    document.documentElement.append(host);
    const cursor = shadow.querySelector<HTMLElement>('.cursor')!;
    document.addEventListener(
      'mousemove',
      (event) => {
        cursor.style.display = 'block';
        cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      },
      true,
    );
    document.addEventListener('pointerdown', () => cursor.classList.add('click'), true);
    document.addEventListener('pointerup', () => cursor.classList.remove('click'), true);
    document.addEventListener('flowprobe:preview', (event) => {
      const state = (event as CustomEvent<PreviewState>).detail;
      shadow.querySelector('.task')!.textContent = state.task;
      shadow.querySelector('.message')!.textContent =
        `${state.turn ? `第 ${state.turn} 轮 · ` : ''}${state.message}`;
      if (state.x !== undefined && state.y !== undefined) {
        cursor.style.display = 'block';
        cursor.style.transform = `translate(${state.x}px, ${state.y}px)`;
      }
      cursor.classList.toggle('click', state.clicking === true);
    });
  });
  if (document.documentElement) document.dispatchEvent(new Event('flowprobe:install'));
  else
    document.addEventListener(
      'DOMContentLoaded',
      () => document.dispatchEvent(new Event('flowprobe:install')),
      { once: true },
    );
}

export async function createPreview(page: Page) {
  await page.addInitScript(installPreview);
  await page.evaluate(installPreview);
  return async (state: PreviewState) => {
    await page.evaluate((state) => {
      document.dispatchEvent(new CustomEvent('flowprobe:preview', { detail: state }));
    }, state);
  };
}
