import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { RunReport } from '../../protocol/src/index.js';
import { safePath, writeJson } from '../../storage/src/index.js';
const escape = (v: unknown): string =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function htmlReport(report: RunReport, directory: string): string {
  const cases = report.cases
    .map(
      (c) =>
        `<section><h2>${escape(c.caseId)} <small>${escape(c.project)}</small></h2><p class="${c.outcome}">${escape(c.outcome)}${c.flaky ? ' · flaky' : ''}</p>${c.attempts.map((a) => `<details open><summary>Attempt ${escape(a.attemptId)} · ${a.durationMs} ms</summary><p>模型调用：${a.modelUsage?.length ?? 0} · 计入预算：$${(a.modelUsage ?? []).reduce((sum, u) => sum + u.chargedUsd, 0).toFixed(6)} · 费用未知：${(a.modelUsage ?? []).filter((u) => u.actualCostUsd === null).length}</p>${a.errors.map((e) => `<pre>${escape(e.code)}: ${escape(e.message)}</pre>`).join('')}<table><thead><tr><th>断言</th><th>结果</th><th>期望</th><th>实际</th></tr></thead><tbody>${a.assertions.map((s) => `<tr><td>${escape(s.assertionId)}</td><td>${escape(s.status)}</td><td><pre>${escape(JSON.stringify(s.expected, null, 2))}</pre></td><td><pre>${escape(JSON.stringify(s.actual, null, 2))}</pre></td></tr>`).join('')}</tbody></table><p>${a.artifacts.map((p) => `<a href="${escape(relative(directory, p).split('/').map(encodeURIComponent).join('/'))}">${escape(p.split('/').at(-1))}</a>`).join(' · ')}</p></details>`).join('')}</section>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:"><title>FlowProbe · ${escape(report.runId)}</title><style>body{font:15px system-ui;background:#f5f7fb;color:#15243a;margin:32px auto;max-width:1100px;padding:0 24px}header,section{background:white;padding:24px;border:1px solid #dce3ef;border-radius:12px;margin-bottom:20px}h1{margin-top:0}small{font-weight:400;color:#64748b}.passed{color:#087f5b}.failed,.error{color:#b42318}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#2257ca}summary{cursor:pointer}</style><header><h1>FlowProbe 测试报告</h1><p class="${report.gate.passed ? 'passed' : 'failed'}">${report.gate.passed ? '门禁通过' : '门禁未通过'}</p><p>${escape(report.runId)} · ${report.gate.completed}/${report.gate.planned} 用例组合</p><p>模式：${escape(report.plan.mode)} · ${escape(report.plan.baseUrl)}</p><pre>${escape(report.gate.reasons.join('\n'))}</pre></header>${cases}</html>`;
}
export function junitReport(report: RunReport): string {
  const failures = report.cases.filter((c) => c.outcome === 'failed').length;
  const errors = report.cases.filter(
    (c) => c.outcome !== 'passed' && c.outcome !== 'failed',
  ).length;
  const cases = report.cases
    .map(
      (c) =>
        `<testcase classname="${escape(c.project)}" name="${escape(c.caseId)}" time="${c.attempts.reduce((n, a) => n + a.durationMs, 0) / 1000}">${c.outcome === 'passed' ? '' : `<${c.outcome === 'failed' ? 'failure' : 'error'} message="${escape(c.outcome)}">${escape(JSON.stringify(c.attempts.at(-1)?.errors))}</${c.outcome === 'failed' ? 'failure' : 'error'}>`}<system-out>${escape(JSON.stringify({ flaky: c.flaky, attempts: c.attempts.length, gate: report.gate }))}</system-out></testcase>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="FlowProbe" tests="${report.cases.length}" failures="${failures}" errors="${errors}">${cases}</testsuite>`;
}
export async function writeReports(directory: string, report: RunReport): Promise<void> {
  await writeJson(safePath(directory, 'report.json'), report);
  await writeJson(safePath(directory, 'gate.json'), report.gate);
  await writeFile(safePath(directory, 'index.html'), htmlReport(report, directory));
  await writeFile(safePath(directory, 'junit.xml'), junitReport(report));
}
