import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ReportWriter } from '../../application/ports/report-writer.js';
import {
  Confidence,
  CriterionStatus,
  FindingCategory,
  OutputFormat,
  Severity,
  Verdict,
} from '../../domain/enums.js';
import type { Finding } from '../../domain/review-output.js';
import type { ReviewReport } from '../../domain/review-report.js';
import { writeFileAtomic } from '../../shared/fs.js';
import type { Redactor } from '../logging/observers.js';

/** Factory Method (Product): transforma o relatório no texto de um formato. */
export interface ReportFormatter {
  /** Extensão do arquivo, com o ponto. */
  readonly extension: string;
  render(report: ReviewReport): string;
}

/**
 * Factory Method (Creator): fixa o algoritmo de gravação e deixa a subclasse
 * decidir qual formatador criar.
 */
export abstract class FileReportWriter implements ReportWriter {
  abstract readonly format: OutputFormat;

  constructor(private readonly redact: Redactor = (text) => text) {}

  /** Factory Method. */
  protected abstract createFormatter(): ReportFormatter;

  async write(report: ReviewReport, directory: string): Promise<string> {
    const formatter = this.createFormatter();
    const filePath = join(directory, this.fileName(formatter));
    await writeFileAtomic(filePath, this.redact(formatter.render(report)));
    return filePath;
  }

  async remove(filePath: string): Promise<void> {
    await rm(filePath, { force: true });
  }

  /** Gancho: formatos com nome de arquivo fixo sobrescrevem. */
  protected fileName(formatter: ReportFormatter): string {
    return `review${formatter.extension}`;
  }
}

/** Factory Method (ConcreteCreator): relatório completo, para máquinas. */
export class JsonReportWriter extends FileReportWriter {
  readonly format = OutputFormat.Json;

  protected createFormatter(): ReportFormatter {
    return new JsonReportFormatter();
  }
}

/** Factory Method (ConcreteCreator): relatório legível, para a leitura da manhã. */
export class MarkdownReportWriter extends FileReportWriter {
  readonly format = OutputFormat.Markdown;

  protected createFormatter(): ReportFormatter {
    return new MarkdownReportFormatter();
  }
}

/** A configuração escolhe os formatos sem if/switch; o Record cobra um writer por formato. */
export const REPORT_WRITERS: Readonly<Record<OutputFormat, (redact?: Redactor) => ReportWriter>> = {
  [OutputFormat.Json]: (redact) => new JsonReportWriter(redact),
  [OutputFormat.Markdown]: (redact) => new MarkdownReportWriter(redact),
};

/** Factory Method (ConcreteProduct). */
export class JsonReportFormatter implements ReportFormatter {
  readonly extension = '.json';

  render(report: ReviewReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
}

const VERDICT_LABEL: Readonly<Record<Verdict, string>> = {
  [Verdict.Approve]: 'Aprovado',
  [Verdict.ChangesRequested]: 'Mudanças solicitadas',
  [Verdict.NeedsDiscussion]: 'Precisa de discussão',
};

const CRITERION_LABEL: Readonly<Record<CriterionStatus, string>> = {
  [CriterionStatus.Met]: '✅ Atendido',
  [CriterionStatus.NotMet]: '❌ Não atendido',
  [CriterionStatus.Unclear]: '❔ Inconclusivo',
};

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  [Severity.Blocker]: 'Blocker',
  [Severity.Major]: 'Major',
  [Severity.Minor]: 'Minor',
  [Severity.Nit]: 'Nit',
};

const CATEGORY_LABEL: Readonly<Record<FindingCategory, string>> = {
  [FindingCategory.Bug]: 'bug',
  [FindingCategory.Security]: 'segurança',
  [FindingCategory.Performance]: 'desempenho',
  [FindingCategory.Tests]: 'testes',
  [FindingCategory.Readability]: 'legibilidade',
  [FindingCategory.Requirements]: 'requisitos',
};

const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  [Confidence.High]: 'alta',
  [Confidence.Medium]: 'média',
  [Confidence.Low]: 'baixa',
};

/** Factory Method (ConcreteProduct). */
export class MarkdownReportFormatter implements ReportFormatter {
  readonly extension = '.md';

  render(report: ReviewReport): string {
    const { task, output } = report;
    const blocks = [
      `# Review: ${task.title}`,
      metadata(report),
      `## Veredito: ${VERDICT_LABEL[output.verdict]}`,
      output.summary,
      '## Critérios de aceite',
      criteria(report),
      `## Achados (${String(output.findings.length)})`,
      ...findings(report),
    ];
    return `${blocks.join('\n\n')}\n`;
  }
}

function metadata({ task, mergeRequest, provider, runId, generatedAt, stats }: ReviewReport): string {
  const usage = [
    `duração ${(stats.durationMs / 1_000).toFixed(1)} s`,
    ...(stats.turns === undefined ? [] : [`${String(stats.turns)} turnos`]),
    ...(stats.costUsd === undefined ? [] : [`custo estimado US$ ${stats.costUsd.toFixed(2)}`]),
  ];
  return [
    `- **Tarefa:** [${task.id}](${task.url}) (${task.source})`,
    `- **Merge request:** [!${String(mergeRequest.iid)} ${mergeRequest.title}](${mergeRequest.webUrl})`,
    `- **Projeto:** ${mergeRequest.projectPath}, \`${mergeRequest.sourceBranch}\` → \`${mergeRequest.targetBranch}\``,
    `- **Head SHA:** \`${mergeRequest.headSha}\``,
    `- **Provedor:** ${provider} (${usage.join(', ')})`,
    `- **Gerado em:** ${generatedAt}, na execução \`${runId}\``,
  ].join('\n');
}

function criteria({ output }: ReviewReport): string {
  if (output.acceptanceCriteria.length === 0) return 'Nenhum critério de aceite avaliado.';
  const rows = output.acceptanceCriteria.map(
    (check) =>
      `| ${cell(check.criterion)} | ${CRITERION_LABEL[check.status]} | ${cell(check.notes)} |`,
  );
  return ['| Critério | Situação | Observações |', '|---|---|---|', ...rows].join('\n');
}

function findings({ output, stats }: ReviewReport): string[] {
  if (output.findings.length === 0) return ['Nenhum achado.'];
  const severities = Object.values(Severity);
  const counts = severities
    .map((severity) => `${SEVERITY_LABEL[severity]} ${String(stats.findingsBySeverity[severity])}`)
    .join(' · ');
  // A ordem do enum vai do mais grave para o menos grave.
  const groups = severities.flatMap((severity) => {
    const group = output.findings.filter((finding) => finding.severity === severity);
    return group.length === 0 ? [] : [`### ${SEVERITY_LABEL[severity]}`, ...group.map(finding)];
  });
  return [counts, ...groups];
}

function finding(item: Finding): string {
  const location = item.line === null ? item.file : `${item.file}:${String(item.line)}`;
  const details = `\`${location}\` · ${CATEGORY_LABEL[item.category]} · confiança ${CONFIDENCE_LABEL[item.confidence]}`;
  return [
    `#### ${item.id} · ${item.title}`,
    details,
    item.comment,
    ...(item.suggestion === null ? [] : [`**Sugestão:**\n\n${item.suggestion}`]),
  ].join('\n\n');
}

/** Texto seguro para uma célula de tabela. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
}
