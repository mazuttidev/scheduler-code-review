import type { EngineRequest } from '../../src/application/ports/review-provider.js';
import { ReviewPromptBuilder } from '../../src/application/prompt/review-prompt-builder.js';
import type { ReviewPrompt } from '../../src/application/prompt/review-prompt.js';
import {
  CodeHostKind,
  Confidence,
  CriterionStatus,
  FindingCategory,
  ProviderKind,
  Severity,
  TaskSourceKind,
  Verdict,
} from '../../src/domain/enums.js';
import type { DiffContext, MergeRequestRef } from '../../src/domain/merge-request.js';
import { reviewOutputJsonSchema } from '../../src/domain/review-output.js';
import type { ReviewOutput } from '../../src/domain/review-output.js';
import { countBySeverity } from '../../src/domain/review-report.js';
import type { ReviewReport } from '../../src/domain/review-report.js';
import type { ReviewTask } from '../../src/domain/review-task.js';

/** Dados de exemplo compartilhados pelos testes. Tudo sintético. */

export const SYSTEM_RULES = 'Você é um revisor de código sênior.';
export const INSTRUCTIONS = '## Avalie\n- Bugs e casos de borda.';

const MERGE_REQUEST_URL = 'https://gitlab.example.com/loja/carrinho/-/merge_requests/1';

export function sampleTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: 't1',
    source: TaskSourceKind.JsonFile,
    url: 'https://tarefas.example.com/t1',
    title: 'Aplicar desconto no carrinho',
    description: 'O total do carrinho deve considerar o cupom informado.',
    businessRules: ['O desconto nunca passa de 50% do total.'],
    acceptanceCriteria: ['Cupom válido reduz o total.', 'Carrinho vazio não quebra.'],
    mergeRequestUrl: MERGE_REQUEST_URL,
    ...overrides,
  };
}

export function sampleMergeRequest(overrides: Partial<MergeRequestRef> = {}): MergeRequestRef {
  return {
    host: CodeHostKind.Local,
    projectId: 1,
    projectPath: 'loja/carrinho',
    iid: 1,
    title: 'Desconto por cupom',
    description: 'Implementa o cálculo do desconto.',
    webUrl: MERGE_REQUEST_URL,
    state: 'opened',
    sourceBranch: 'feature/desconto',
    targetBranch: 'main',
    diffRefs: {
      baseSha: 'a'.repeat(40),
      startSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
    ...overrides,
  };
}

export function sampleDiff(overrides: Partial<DiffContext> = {}): DiffContext {
  const patch = [
    'diff --git a/src/discount.ts b/src/discount.ts',
    '--- a/src/discount.ts',
    '+++ b/src/discount.ts',
    '@@ -1,3 +1,5 @@',
    ' export function discountRate(total: number, coupon: number): number {',
    '-  return 0;',
    '+  return coupon / total;',
    ' }',
  ].join('\n');
  return {
    patch,
    files: [{ path: 'src/discount.ts', status: 'modified', additions: 1, deletions: 1 }],
    bytes: Buffer.byteLength(patch),
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    ...overrides,
  };
}

/** Builder com todas as partes obrigatórias já informadas. */
export function completeBuilder(): ReviewPromptBuilder {
  return new ReviewPromptBuilder()
    .withSystemRules(SYSTEM_RULES)
    .withInstructions(INSTRUCTIONS)
    .withTask(sampleTask())
    .withMergeRequest(sampleMergeRequest())
    .withDiff(sampleDiff())
    .withOutputSchema(reviewOutputJsonSchema());
}

export function samplePrompt(): ReviewPrompt {
  return completeBuilder().build();
}

export function sampleOutput(): ReviewOutput {
  return {
    summary: 'O MR implementa o desconto, mas divide por zero com o carrinho vazio.',
    verdict: Verdict.ChangesRequested,
    acceptanceCriteria: [
      { criterion: 'Cupom válido reduz o total.', status: CriterionStatus.Met, notes: '' },
      { criterion: 'Carrinho vazio não quebra.', status: CriterionStatus.NotMet, notes: 'Veja F1.' },
    ],
    findings: [
      {
        id: 'F1',
        severity: Severity.Major,
        category: FindingCategory.Bug,
        file: 'src/discount.ts',
        line: 2,
        title: 'Divisão por zero',
        comment: 'Com o carrinho vazio, o total é zero e a taxa vira Infinity.',
        suggestion: 'Devolva 0 quando o total for 0.',
        confidence: Confidence.High,
      },
    ],
  };
}

export function sampleReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  const task = sampleTask();
  const mergeRequest = sampleMergeRequest();
  const output = sampleOutput();
  return {
    runId: '2026-10-12T05-55-00Z-k3x9',
    generatedAt: '2026-10-12T06:01:37.552Z',
    provider: ProviderKind.Fake,
    task: { id: task.id, title: task.title, url: task.url, source: task.source },
    mergeRequest: {
      iid: mergeRequest.iid,
      title: mergeRequest.title,
      webUrl: mergeRequest.webUrl,
      projectPath: mergeRequest.projectPath,
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      headSha: mergeRequest.diffRefs.headSha,
    },
    output,
    stats: {
      findingsBySeverity: countBySeverity(output.findings),
      durationMs: 6_600,
      turns: 4,
    },
    ...overrides,
  };
}

export function sampleRequest(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    prompt: { system: 'Regras do sistema.', user: 'Revise o merge request.' },
    workingDirectory: '/tmp/worktree',
    outputSchema: reviewOutputJsonSchema(),
    correlation: { runId: 'run-1', taskId: 't1' },
    ...overrides,
  };
}
