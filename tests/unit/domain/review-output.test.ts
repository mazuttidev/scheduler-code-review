import { describe, expect, it } from 'vitest';

import {
  Confidence,
  CriterionStatus,
  FindingCategory,
  Severity,
  Verdict,
} from '../../../src/domain/enums.js';
import {
  ReviewOutputSchema,
  reviewOutputJsonSchema,
} from '../../../src/domain/review-output.js';
import { countBySeverity } from '../../../src/domain/review-report.js';

function validFinding(): Record<string, unknown> {
  return {
    id: 'F1',
    severity: 'major',
    category: 'bug',
    file: 'src/discount.ts',
    line: 12,
    title: 'Divisão por zero',
    comment: 'O total pode ser zero quando o carrinho está vazio.',
    suggestion: null,
    confidence: 'high',
  };
}

function validOutput(): Record<string, unknown> {
  return {
    summary: 'O MR implementa o desconto, mas falha com carrinho vazio.',
    verdict: 'changes_requested',
    acceptanceCriteria: [
      { criterion: 'Desconto aplicado ao total', status: 'met', notes: '' },
      { criterion: 'Carrinho vazio não quebra', status: 'not_met', notes: 'Veja F1.' },
    ],
    findings: [validFinding()],
  };
}

describe('ReviewOutputSchema', () => {
  it('aceita um exemplo válido e devolve os enums do domínio', () => {
    const output = ReviewOutputSchema.parse(validOutput());

    expect(output.verdict).toBe(Verdict.ChangesRequested);
    expect(output.acceptanceCriteria[1]?.status).toBe(CriterionStatus.NotMet);
    expect(output.findings[0]).toMatchObject({
      severity: Severity.Major,
      category: FindingCategory.Bug,
      confidence: Confidence.High,
    });
  });

  it('aceita linha nula, para achados do arquivo inteiro', () => {
    const output = { ...validOutput(), findings: [{ ...validFinding(), line: null }] };

    expect(ReviewOutputSchema.safeParse(output).success).toBe(true);
  });

  it('rejeita severidade inválida', () => {
    const output = { ...validOutput(), findings: [{ ...validFinding(), severity: 'critical' }] };

    expect(ReviewOutputSchema.safeParse(output).success).toBe(false);
  });

  it.each([-1, 0, 1.5])('rejeita a linha %s', (line) => {
    const output = { ...validOutput(), findings: [{ ...validFinding(), line }] };

    expect(ReviewOutputSchema.safeParse(output).success).toBe(false);
  });

  it.each(['summary', 'verdict', 'acceptanceCriteria', 'findings'])(
    'rejeita a saída sem o campo %s',
    (field) => {
      const output = validOutput();
      Reflect.deleteProperty(output, field);

      expect(ReviewOutputSchema.safeParse(output).success).toBe(false);
    },
  );

  it('rejeita um achado sem campo obrigatório', () => {
    const finding = validFinding();
    Reflect.deleteProperty(finding, 'comment');

    const result = ReviewOutputSchema.safeParse({ ...validOutput(), findings: [finding] });

    expect(result.success).toBe(false);
  });
});

describe('reviewOutputJsonSchema', () => {
  const serialized = JSON.stringify(reviewOutputJsonSchema());

  it('declara draft-07', () => {
    expect(reviewOutputJsonSchema().$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it.each([
    ['Severity', Object.values(Severity)],
    ['FindingCategory', Object.values(FindingCategory)],
    ['Confidence', Object.values(Confidence)],
    ['CriterionStatus', Object.values(CriterionStatus)],
    ['Verdict', Object.values(Verdict)],
  ])('lista os valores do enum %s', (_name, values) => {
    expect(serialized).toContain(`"enum":${JSON.stringify(values)}`);
  });
});

describe('countBySeverity', () => {
  it('conta os achados e zera as severidades ausentes', () => {
    const counts = countBySeverity([
      { severity: Severity.Major },
      { severity: Severity.Major },
      { severity: Severity.Nit },
    ]);

    expect(counts).toEqual({ blocker: 0, major: 2, minor: 0, nit: 1 });
  });
});
