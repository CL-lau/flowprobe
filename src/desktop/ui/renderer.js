const $ = (id) => document.getElementById(id);
const api = window.flowprobe;
let current = {};
let lastMessages = '';
let lastEvents = '';
let errorTimer;
const statusText = {
  idle: '准备就绪',
  running: '正在执行',
  pausing: '正在完成当前操作，随后交还控制…',
  manual: '已暂停 · 由你操作',
  done: '任务已完成',
  blocked: '任务受阻',
  cancelled: '任务已停止',
  error: '执行失败',
};
function showError(text) {
  $('error').textContent = text;
  $('error').classList.remove('hidden');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => $('error').classList.add('hidden'), 12000);
}
async function command(value) {
  try {
    const result = await api.command(value);
    if (!result.ok) {
      showError(result.error);
      return false;
    }
    if (result.state) render(result.state);
    return true;
  } catch (error) {
    showError(error.message);
    return false;
  }
}
function actionLabel(action = {}) {
  const names = {
    navigate: '打开页面',
    fill: '填写',
    click: '点击',
    select: '选择',
    check: '勾选',
    press: '按键',
    point: '视觉点击',
    scroll: '滚动',
    wait: '等待',
    move: '移动鼠标',
    drag: '拖拽',
    launch: '打开应用',
    type: '输入文字',
  };
  const target = action.target || {};
  return `${names[action.type] || action.type || '执行操作'} ${target.name || target.label || target.testId || target.css || action.app || action.key || ''}`.trim();
}
function render(state) {
  current = state;
  const busy = state.active || ['running', 'pausing', 'manual'].includes(state.status);
  document.documentElement.style.setProperty('--sidebar-width', `${state.sidebarWidth || 460}px`);
  document.body.className = `${state.expanded ? '' : 'collapsed'} ${state.status === 'running' ? 'running' : ''} ${state.status === 'manual' ? 'manual' : ''} ${state.status === 'error' ? 'error-state' : ''}`;
  $('status').textContent = !state.ready
    ? '正在连接浏览器…'
    : statusText[state.status] || state.status;
  $('model').textContent = state.model;
  $('calls').textContent = state.calls ? `${state.calls} 次模型调用` : '';
  $('run').disabled = !state.ready || busy;
  $('mode').disabled = busy;
  $('pause').disabled = !busy || ['pausing', 'manual'].includes(state.status);
  $('stop').disabled = !busy;
  $('artifacts').disabled = !state.artifactDirectory;
  $('handoff').classList.toggle('hidden', state.status !== 'manual');
  $('toggle').textContent = state.expanded ? '收起侧栏 ◨' : '展开浏览器 ◧';
  const computer = state.mode === 'desktop';
  $('surface-title').textContent = computer ? '整个电脑' : '浏览器';
  $('surface-icon').textContent = computer ? '⌘' : '◎';
  $('desktop-preview').classList.toggle('hidden', !computer || !state.expanded);
  $('placeholder').classList.toggle(
    'hidden',
    computer || Boolean(state.url && state.url !== 'about:blank#flowprobe-browser'),
  );
  if (state.desktopImage) $('desktop-image').src = state.desktopImage;
  if (document.activeElement !== $('url') && /^https?:/.test(state.url || ''))
    $('url').value = state.url;
  if (!$('url').value && state.lastUrl) $('url').value = state.lastUrl;
  const permission = state.permissions || {};
  const values = permission.permissions || permission;
  const a = values.accessibility?.state;
  const s = values.screen_recording?.state;
  $('permission-state').textContent = state.hasKey
    ? `模型已配置 · 驱动辅助功能 ${a === 'granted' ? '✓' : a === 'denied' ? '未授权' : '待检查'} · 屏幕录制 ${s === 'granted' ? '✓' : s === 'denied' ? '未授权' : '待检查'}`
    : '未配置 API Key；可在设置中添加或使用环境变量';
  const messageKey = JSON.stringify(state.messages);
  if (messageKey !== lastMessages) {
    lastMessages = messageKey;
    $('messages').replaceChildren();
    for (const item of state.messages || []) {
      const element = document.createElement('div');
      element.className = `message ${item.role}`;
      const author = document.createElement('div');
      author.className = 'author';
      author.textContent = item.role === 'user' ? 'YOU' : 'FLOWPROBE';
      const text = document.createElement('div');
      text.textContent = item.text;
      element.append(author, text);
      $('messages').append(element);
    }
    $('welcome').classList.toggle('hidden', Boolean(state.messages?.length));
    $('conversation').scrollTop = $('conversation').scrollHeight;
  }
  const eventKey = JSON.stringify(state.events);
  if (eventKey !== lastEvents) {
    lastEvents = eventKey;
    $('timeline').replaceChildren();
    for (const item of (state.events || [])
      .filter((e) => ['action', 'handoff', 'observation', 'plan.discarded'].includes(e.type))
      .slice(-12)) {
      const row = document.createElement('div');
      row.className = 'event';
      const time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false });
      const text = document.createElement('span');
      text.textContent =
        item.type === 'action'
          ? actionLabel(item.action)
          : item.type === 'handoff'
            ? '等待你接管'
            : item.type === 'plan.discarded'
              ? '页面已变化，重新规划'
              : `观察${computer ? '电脑' : '网页'} · 第 ${item.turn} 轮`;
      row.append(time, text);
      $('timeline').append(row);
    }
    $('conversation').scrollTop = $('conversation').scrollHeight;
  }
}
async function run() {
  const text = $('task').value.trim();
  if (!text) return;
  const ok = await command({
    type: 'run',
    task: text,
    mode: $('mode').value,
    url: $('url').value.trim() || undefined,
  });
  if (ok) $('task').value = '';
}
$('run').onclick = run;
$('task').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
};
$('pause').onclick = () => command({ type: 'pause' });
$('resume').onclick = () => command({ type: 'resume' });
$('stop').onclick = () => command({ type: 'stop' });
$('toggle').onclick = () => command({ type: 'toggle-browser' });
$('back').onclick = () => command({ type: 'back' });
$('forward').onclick = () => command({ type: 'forward' });
$('reload').onclick = () => command({ type: 'reload' });
$('address-form').onsubmit = (e) => {
  e.preventDefault();
  if ($('url').value.trim()) command({ type: 'open', url: $('url').value.trim() });
};
$('permissions').onclick = () => {
  $('permission-panel').classList.toggle('hidden');
};
$('quick-accessibility').onclick = () =>
  command({ type: 'quick-permission', permission: 'accessibility' });
$('quick-screen').onclick = () => command({ type: 'quick-permission', permission: 'screen' });
$('refresh-permissions').onclick = () => command({ type: 'refresh-permissions' });
$('artifacts').onclick = () => command({ type: 'artifacts' });
$('example').onclick = () => {
  $('url').value = 'https://www.selenium.dev/selenium/web/web-form.html';
  $('task').value =
    '将 Text input 填为 FlowProbe，将 Textarea 填为 桌面客户端验证，选择 Two，提交表单并确认结果页显示 Form submitted 和 Received!';
  $('task').focus();
};
$('open-example').onclick = () => {
  const url = 'https://www.selenium.dev/selenium/web/web-form.html';
  $('url').value = url;
  command({ type: 'open', url });
};
api.onState(render);
command({ type: 'state' });
setInterval(() => {
  if (current.startedAt && ['running', 'pausing', 'manual'].includes(current.status)) {
    const seconds = Math.floor((Date.now() - current.startedAt) / 1000);
    $('elapsed').textContent =
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  } else $('elapsed').textContent = '';
}, 1000);

$('show-driver').onclick = () => command({ type: 'show-driver' });
$('show-client').onclick = () => command({ type: 'show-client' });

const settingsPanel = $('settings-panel');
async function closeSettings() {
  settingsPanel.classList.add('hidden');
  $('setting-key').value = '';
  await command({ type: 'settings-visible', visible: false });
}
$('settings-open').onclick = async () => {
  if (current.active) {
    showError('请在任务结束后修改设置');
    return;
  }
  if (!(await command({ type: 'settings-visible', visible: true }))) return;
  const settings = current.settings;
  $('setting-model').value = settings.model;
  $('setting-base').value = settings.baseUrl;
  $('setting-turns').value = settings.maxTurns;
  $('setting-vision').checked = settings.vision;
  $('setting-key').value = '';
  $('settings-error').textContent = '';
  settingsPanel.classList.remove('hidden');
  $('setting-model').focus();
};
$('settings-close').onclick = closeSettings;
$('settings-cancel').onclick = closeSettings;
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  const result = await api.command({
    type: 'save-settings',
    model: $('setting-model').value.trim(),
    baseUrl: $('setting-base').value.trim().replace(/\/+$/, ''),
    maxTurns: Number($('setting-turns').value),
    vision: $('setting-vision').checked,
    ...($('setting-key').value ? { apiKey: $('setting-key').value } : {}),
  });
  if (!result.ok) {
    $('settings-error').textContent = result.error;
    return;
  }
  render(result.state);
  await closeSettings();
};
