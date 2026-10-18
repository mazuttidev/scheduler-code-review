import { describe, expect, it } from 'vitest';

import {
  Confidence,
  CriterionStatus,
  FindingCategory,
  Severity,
  Verdict,
} from '../../src/domain/enums.js';
import type { Finding, ReviewOutput } from '../../src/domain/review-output.js';
import { countBySeverity } from '../../src/domain/review-report.js';
import type { ReviewReport } from '../../src/domain/review-report.js';
import {
  JsonReportFormatter,
  MarkdownReportFormatter,
} from '../../src/infrastructure/reports/file-report-writers.js';
import { sampleOutput, sampleReport } from '../helpers/samples.js';

function reportWith(output: ReviewOutput, stats: Partial<ReviewReport['stats']> = {}): ReviewReport {
  return sampleReport({
    output,
    stats: {
      findingsBySeverity: countBySeverity(output.findings),
      durationMs: 6_600,
      ...stats,
    },
  });
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'F1',
    severity: Severity.Minor,
    category: FindingCategory.Readability,
    file: 'src/cart.ts',
    line: 10,
    title: 'Nome pouco claro',
    comment: 'A variável `x` guarda o total.',
    suggestion: null,
    confidence: Confidence.Medium,
    ...overrides,
  };
}

describe('JsonReportFormatter', () => {
  it('serializa o relatório inteiro, com quebra de linha no fim', () => {
    const formatter = new JsonReportFormatter();
    const report = sampleReport();

    const text = formatter.render(report);

    expect(formatter.extension).toBe('.json');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(report);
  });
});

describe('MarkdownReportFormatter', () => {
  const formatter = new MarkdownReportFormatter();

  it('monta o relatório com cabeçalho, veredito, critérios e achados', () => {
    const expected = [
      '# Review: Aplicar desconto no carrinho',
      '',
      '- **Tarefa:** [t1](https://tarefas.example.com/t1) (json-file)',
      '- **Merge request:** [!1 Desconto por cupom](https://gitlab.example.com/loja/carrinho/-/merge_requests/1)',
      '- **Projeto:** loja/carrinho, `feature/desconto` → `main`',
      `- **Head SHA:** \`${'b'.repeat(40)}\``,
      '- **Provedor:** fake (duração 6.6 s, 4 turnos)',
      '- **Gerado em:** 2026-10-12T06:01:37.552Z, na execução `2026-10-12T05-55-00Z-k3x9`',
      '',
      '## Veredito: Mudanças solicitadas',
      '',
      'O MR implementa o desconto, mas divide por zero com o carrinho vazio.',
      '',
      '## Critérios de aceite',
      '',
      '| Critério | Situação | Observações |',
      '|---|---|---|',
      '| Cupom válido reduz o total. | ✅ Atendido |  |',
      '| Carrinho vazio não quebra. | ❌ Não atendido | Veja F1. |',
      '',
      '## Achados (1)',
      '',
      'Blocker 0 · Major 1 · Minor 0 · Nit 0',
      '',
      '### Major',
      '',
      '#### F1 · Divisão por zero',
      '',
      '`src/discount.ts:2` · bug · confiança alta',
      '',
      'Com o carrinho vazio, o total é zero e a taxa vira Infinity.',
      '',
      '**Sugestão:**',
      '',
      'Devolva 0 quando o total for 0.',
      '',
    ].join('\n');

    expect(formatter.extension).toBe('.md');
    expect(formatter.render(sampleReport())).toBe(expected);
  });

  it('agrupa os achados do mais grave para o menos grave', () => {
    const output = {
      ...sampleOutput(),
      findings: [
        finding({ id: 'F1', severity: Severity.Nit }),
        finding({ id: 'F2', severity: Severity.Blocker }),
        finding({ id: 'F3', severity: Severity.Nit }),
      ],
    };

    const text = formatter.render(reportWith(output));

    const order = ['### Blocker', '#### F2', '### Nit', '#### F1', '#### F3'].map((part) =>
      text.indexOf(part),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
    expect(text).toContain('Blocker 1 · Major 0 · Minor 0 · Nit 2');
    expect(text).not.toContain('### Major');
  });

  it('mostra só o arquivo quando o achado não tem linha, e omite a sugestão ausente', () => {
    const output = { ...sampleOutput(), findings: [finding({ line: null })] };

    const text = formatter.render(reportWith(output));

    expect(text).toContain('`src/cart.ts` · legibilidade · confiança média');
    expect(text).not.toContain('Sugestão');
  });

  it('deixa claro quando não há achados nem critérios', () => {
    const output: ReviewOutput = {
      summary: 'Nada a apontar.',
      verdict: Verdict.Approve,
      acceptanceCriteria: [],
      findings: [],
    };

    const text = formatter.render(reportWith(output));

    expect(text).toContain('## Veredito: Aprovado');
    expect(text).toContain('## Critérios de aceite\n\nNenhum critério de aceite avaliado.');
    expect(text).toContain('## Achados (0)\n\nNenhum achado.\n');
  });

  it('não deixa o texto de um critério quebrar a tabela', () => {
    const output = {
      ...sampleOutput(),
      acceptanceCriteria: [
        {
          criterion: 'Aceita cupom A | cupom B',
          status: CriterionStatus.Unclear,
          notes: 'Linha 1\nLinha 2',
        },
      ],
    };

    const text = formatter.render(reportWith(output));

    expect(text).toContain('| Aceita cupom A \\| cupom B | ❔ Inconclusivo | Linha 1<br>Linha 2 |');
  });

  it('mostra turnos e custo só quando o provedor os informa', () => {
    const withCost = formatter.render(reportWith(sampleOutput(), { turns: 12, costUsd: 0.4231 }));
    const bare = formatter.render(reportWith(sampleOutput()));

    expect(withCost).toContain('(duração 6.6 s, 12 turnos, custo estimado US$ 0.42)');
    expect(bare).toContain('- **Provedor:** fake (duração 6.6 s)');
  });
});
