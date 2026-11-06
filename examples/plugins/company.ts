import type { PluginSet } from '../../packages/plugins/src/index.js';

export default {
  protocolMajor: 1,
  fixtures: [
    {
      name: 'company.orderDraft',
      version: '1',
      async setup(_input, ctx) {
        ctx.signal.throwIfAborted();
        await ctx.recordResource({ kind: 'session-orders' });
        const response = await ctx.api.post(new URL('/api/reset', ctx.baseUrl).href);
        if (!response.ok()) throw new Error('Unable to initialize isolated order session');
        return { title: `采购-${ctx.attemptId}`, operationKey: ctx.attemptId };
      },
      async cleanup(resources, ctx) {
        if (!resources.length) return;
        ctx.signal.throwIfAborted();
        const response = await ctx.api.post(new URL('/api/reset', ctx.baseUrl).href);
        if (!response.ok()) throw new Error('Unable to clean order session');
        const state = await ctx.api.get(new URL('/api/orders', ctx.baseUrl).href);
        const data = (await state.json()) as { total: number };
        if (data.total !== 0) throw new Error('Order resources remain after cleanup');
      },
    },
  ],
  preconditions: [
    {
      name: 'orders.pageReady',
      version: '1',
      async check(ctx) {
        return await ctx.page.getByRole('heading', { name: '订单管理', exact: true }).isVisible();
      },
    },
  ],
  planners: [
    {
      name: 'company.createOrder',
      version: '1',
      modelBased: false,
      async plan(action, ctx) {
        ctx.signal.throwIfAborted();
        if (action.scope.component !== 'order-create-dialog')
          throw new Error('Unsupported component');
        if (typeof action.inputs['title'] !== 'string') throw new Error('Title template required');
        return [
          {
            type: 'fill',
            target: { label: '订单标题' },
            value: action.inputs['title'],
            effect: 'none',
          },
          { type: 'fill', target: { label: '金额（元）' }, value: '100', effect: 'none' },
          { type: 'click', target: { role: 'button', name: '提交订单' }, effect: 'non-idempotent' },
        ];
      },
    },
  ],
  assertions: [
    {
      name: 'company.order.persisted',
      version: '1',
      async observe(input, ctx) {
        ctx.signal.throwIfAborted();
        const response = await ctx.api.get(new URL('/api/orders', ctx.baseUrl).href);
        const body = (await response.json()) as {
          orders: { title: string; amountMinor: number }[];
        };
        return {
          status: response.status(),
          orders: body.orders.filter((order) => order.title === input['expectedTitle']),
        };
      },
      evaluate(actual, input) {
        const data = actual as { status: number; orders: { title: string; amountMinor: number }[] };
        return {
          status:
            data.status === 200 &&
            data.orders.length === 1 &&
            data.orders[0]?.amountMinor === input['expectedAmountMinor']
              ? 'passed'
              : 'failed',
          expected: {
            status: 200,
            count: 1,
            title: input['expectedTitle'],
            amountMinor: input['expectedAmountMinor'],
          },
        };
      },
    },
  ],
} satisfies PluginSet;
