interface SimOrder {
  id: string;
  title: string;
  amountMinor: number;
  status: string;
}
const app = document.querySelector<HTMLDivElement>('#app')!;
const heading = document.querySelector<HTMLHeadingElement>('#heading')!;
const pathname = location.pathname;
for (const link of document.querySelectorAll('nav a'))
  if (new URL((link as HTMLAnchorElement).href).pathname === pathname) link.classList.add('active');
const session = (await fetch('/api/session').then((r) => r.json())) as {
  role: string;
  fault: string;
};
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
if (pathname === '/controls') {
  heading.textContent = '复杂交互控件';
  app.innerHTML = `<section class="panel"><h2>异步项目筛选</h2><label>搜索项目<input aria-label="搜索项目" placeholder="输入项目名称"></label><p data-testid="loading">等待搜索</p><ul data-testid="results"></ul><label>日期范围<select aria-label="日期范围"><option value="all">全部日期</option><option value="month">本月</option><option value="quarter">本季度</option></select></label><p data-testid="range">全部日期</p><label><input type="checkbox" aria-label="仅显示异常">仅显示异常</label><p data-testid="filter">全部项目</p></section>`;
  let timer: ReturnType<typeof setTimeout>;
  document.querySelector('input')!.addEventListener('input', (e) => {
    clearTimeout(timer);
    document.querySelector('[data-testid=loading]')!.textContent = '加载中';
    const value = (e.target as HTMLInputElement).value;
    timer = setTimeout(() => {
      document.querySelector('[data-testid=results]')!.innerHTML = [
        '华东采购',
        '华南研发',
        '华北运营',
      ]
        .filter((x) => x.includes(value))
        .map((x) => `<li>${x}</li>`)
        .join('');
      document.querySelector('[data-testid=loading]')!.textContent = '加载完成';
    }, 350);
  });
  document.querySelector('select')!.addEventListener('change', (e) => {
    document.querySelector('[data-testid=range]')!.textContent = (
      e.target as HTMLSelectElement
    ).selectedOptions[0]!.text;
  });
  document.querySelector('[type=checkbox]')!.addEventListener('change', (e) => {
    document.querySelector('[data-testid=filter]')!.textContent = (e.target as HTMLInputElement)
      .checked
      ? '异常项目'
      : '全部项目';
  });
} else if (pathname === '/canvas') {
  heading.textContent = 'Canvas 工作流编辑器';
  app.innerHTML = `<section class="panel"><h2>审批流程</h2><p>点击画布添加节点，保存后检查节点数量与序列。</p><canvas width="800" height="320" aria-label="流程画布" data-testid="workflow"></canvas><p data-testid="node-count">节点数：0</p><button id="add">添加审批节点</button><button id="save">保存流程</button><output data-testid="saved-graph"></output></section>`;
  const canvas = document.querySelector('canvas')!,
    ctx = canvas.getContext('2d')!;
  const nodes: { x: number; y: number; label: string }[] = [];
  const draw = (): void => {
    ctx.clearRect(0, 0, 800, 320);
    for (const [i, node] of nodes.entries()) {
      ctx.fillStyle = '#2465dd';
      ctx.fillRect(node.x, node.y, 130, 55);
      ctx.fillStyle = 'white';
      ctx.font = '16px system-ui';
      ctx.fillText(node.label, node.x + 17, node.y + 33);
      if (i) {
        const previous = nodes[i - 1]!;
        ctx.strokeStyle = '#8298b5';
        ctx.beginPath();
        ctx.moveTo(previous.x + 130, previous.y + 27);
        ctx.lineTo(node.x, node.y + 27);
        ctx.stroke();
      }
    }
    document.querySelector('[data-testid=node-count]')!.textContent = `节点数：${nodes.length}`;
  };
  document.querySelector('#add')!.addEventListener('click', () => {
    nodes.push({ x: 30 + nodes.length * 190, y: 110, label: `审批 ${nodes.length + 1}` });
    draw();
  });
  canvas.addEventListener('click', (e) => {
    nodes.push({ x: e.offsetX, y: e.offsetY, label: `审批 ${nodes.length + 1}` });
    draw();
  });
  document.querySelector('#save')!.addEventListener('click', () => {
    document.querySelector('output')!.textContent = JSON.stringify({
      nodes: nodes.map((n) => n.label),
      edges: Math.max(0, nodes.length - 1),
    });
  });
} else if (pathname === '/frames') {
  heading.textContent = '嵌入页面与组件';
  app.innerHTML =
    '<section class="panel"><h2>嵌入审批</h2><iframe title="审批面板" src="/embedded"></iframe><div id="shadow-host"></div></section>';
  const root = document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<label>组件备注 <input aria-label="组件备注"></label>';
} else if (pathname === '/permissions') {
  heading.textContent = '角色权限验证';
  app.innerHTML = `<section class="panel"><h2>当前角色</h2><p data-testid="role">${escapeHtml(session.role)}</p><p data-testid="permission">${session.role === 'admin' ? '可编辑' : '只读访问'}</p>${session.role === 'admin' ? '<button>修改订单</button>' : ''}<p>前端隐藏操作和后端权限拒绝必须同时验收。</p></section>`;
} else {
  heading.textContent = '订单管理';
  app.innerHTML = `<div class="cards"><div class="card"><span>本次会话订单</span><b data-testid="total">0</b></div><div class="card"><span>当前角色</span><b>${escapeHtml(session.role)}</b></div><div class="card"><span>运行模式</span><b>${session.fault ? '故障注入' : '正常业务'}</b></div></div><section class="panel" data-testid="order-create-dialog"><h2>创建订单</h2><form><label>订单标题<input name="title" aria-label="订单标题" required></label><label>金额（元）<input name="amount" aria-label="金额（元）" type="number" min="0.01" step="0.01" required></label><button type="submit">提交订单</button></form><p role="status" id="notice"></p></section><section class="panel"><h2>订单列表</h2><table><thead><tr><th>订单标题</th><th>金额</th><th>状态</th></tr></thead><tbody></tbody></table></section>`;
  const refresh = async (): Promise<void> => {
    const data = (await fetch('/api/orders').then((r) => r.json())) as {
      orders: SimOrder[];
      total: number;
    };
    document.querySelector('[data-testid=total]')!.textContent = String(data.total);
    document.querySelector('tbody')!.innerHTML = data.orders
      .map(
        (o) =>
          `<tr data-testid="order-row"><td>${escapeHtml(o.title)}</td><td>¥${(o.amountMinor / 100).toFixed(2)}</td><td>${o.status}</td></tr>`,
      )
      .join('');
  };
  document.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement,
      data = new FormData(form);
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: data.get('title'),
        amountMinor: Math.round(Number(data.get('amount')) * 100),
      }),
    });
    const notice = document.querySelector('#notice')!;
    notice.textContent = response.ok ? '订单创建成功' : '创建失败，请检查权限或服务';
    notice.className = response.ok ? '' : 'error';
    await refresh();
  });
  await refresh();
}
export {};
