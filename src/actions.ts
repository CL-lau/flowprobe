import { z } from 'zod';
export const targetSchema = z
  .object({
    testId: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    css: z.string().optional(),
    matchText: z.string().optional(),
    frame: z.string().optional(),
    scopeTestId: z.string().optional(),
  })
  .strict()
  .refine(
    (t) => [t.testId, t.role, t.label, t.css].filter((v) => v !== undefined).length === 1,
    'Exactly one of testId, role, label or css is required',
  );
const effect = z.enum(['none', 'idempotent', 'non-idempotent']).default('none');
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), path: z.string(), effect }).strict(),
  z.object({ type: z.literal('click'), target: targetSchema, effect }).strict(),
  z.object({ type: z.literal('fill'), target: targetSchema, value: z.string(), effect }).strict(),
  z.object({ type: z.literal('select'), target: targetSchema, value: z.string(), effect }).strict(),
  z
    .object({ type: z.literal('check'), target: targetSchema, checked: z.boolean(), effect })
    .strict(),
  z
    .object({
      type: z.literal('point'),
      target: targetSchema,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      expectedSize: z
        .object({ width: z.number().positive(), height: z.number().positive() })
        .strict(),
      effect,
    })
    .strict(),
  z.object({ type: z.literal('press'), target: targetSchema, key: z.string(), effect }).strict(),
  z.object({ type: z.literal('scroll'), deltaY: z.number().min(-5000).max(5000), effect }).strict(),
  z
    .object({
      type: z.literal('wait'),
      target: targetSchema,
      state: z.enum(['visible', 'hidden']),
      effect,
    })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export type Target = z.infer<typeof targetSchema>;
