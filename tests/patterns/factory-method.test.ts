import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReportWriter } from '../../src/application/ports/report-writer.js';
import { OutputFormat } from '../../src/domain/enums.js';
import { createRedactor } from '../../src/infrastructure/logging/observers.js';
import {
  FileReportWriter,
  JsonReportWriter,
  MarkdownReportWriter,
  REPORT_WRITERS,
} from '../../src/infrastructure/reports/file-report-writers.js';
import type { ReportFormatter } from '../../src/infrastructure/reports/file-report-writers.js';
import { sampleOutput, sampleReport } from '../helpers/samples.js';

/**
 * Factory Method no nightly-review.
 *
 * - Creator: `FileReportWriter`, que fixa o algoritmo de gravação.
 * - ConcreteCreator: `JsonReportWriter` e `MarkdownReportWriter`.
 * - Product: `ReportFormatter`.
 * - ConcreteProduct: `JsonReportFormatter` e `MarkdownReportFormatter`.
 *
 * Todo relatório é gravado do mesmo jeito; o que muda é o formatador, e quem
 * decide qual criar é a subclasse.
 */

describe('Factory Method: FileReportWriter', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nightly-review-reports-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('o JsonReportWriter grava review.json com o relatório completo', async () => {
    const report = sampleReport();
    const writer = new JsonReportWriter();

    const filePath = await writer.write(report, directory);

    expect(writer.format).toBe(OutputFormat.Json);
    expect(filePath).toBe(join(directory, 'review.json'));
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(report);
  });

  it('o MarkdownReportWriter grava review.md com o relatório legível', async () => {
    const writer = new MarkdownReportWriter();

    const filePath = await writer.write(sampleReport(), directory);

    const content = await readFile(filePath, 'utf8');
    expect(writer.format).toBe(OutputFormat.Markdown);
    expect(filePath).toBe(join(directory, 'review.md'));
    expect(content).toContain('# Review: Aplicar desconto no carrinho');
    expect(content).toContain('## Veredito: Mudanças solicitadas');
  });

  it('as duas subclasses compartilham a gravação: cria a pasta, usa modo 600 e não deixa .tmp', async () => {
    const target = join(directory, 'reviews', 't1');
    const report = sampleReport();

    const paths = [
      await new JsonReportWriter().write(report, target),
      await new MarkdownReportWriter().write(report, target),
    ];

    expect(await readdir(target)).toEqual(['review.json', 'review.md']);
    for (const filePath of paths) {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('remove() apaga o arquivo e não falha se ele já não existe', async () => {
    const writer = new JsonReportWriter();
    const filePath = await writer.write(sampleReport(), directory);

    await writer.remove(filePath);
    await expect(writer.remove(filePath)).resolves.toBeUndefined();

    expect(await readdir(directory)).toEqual([]);
  });

  it('mascara os segredos antes de gravar', async () => {
    const token = 'glpat-segredo-de-teste-123';
    const output = { ...sampleOutput(), summary: `O MR expõe o token ${token}.` };
    const writers = Object.values(REPORT_WRITERS).map((create) => create(createRedactor([token])));

    const paths = await Promise.all(
      writers.map((writer) => writer.write(sampleReport({ output }), directory)),
    );

    for (const filePath of paths) {
      const content = await readFile(filePath, 'utf8');
      expect(content).not.toContain(token);
      expect(content).toContain('O MR expõe o token [REDACTED].');
    }
  });

  it('um formato novo é só uma subclasse: escolhe o formatador e, se quiser, o nome do arquivo', async () => {
    // Esboço do Code Quality do GitLab, que exige um nome de arquivo fixo.
    class FindingsOnlyReportWriter extends FileReportWriter {
      readonly format = OutputFormat.Json;

      protected createFormatter(): ReportFormatter {
        return {
          extension: '.json',
          render: (report) => JSON.stringify(report.output.findings.map((finding) => finding.id)),
        };
      }

      protected override fileName(): string {
        return 'gl-code-quality-report.json';
      }
    }

    const filePath = await new FindingsOnlyReportWriter().write(sampleReport(), directory);

    expect(filePath).toBe(join(directory, 'gl-code-quality-report.json'));
    expect(await readFile(filePath, 'utf8')).toBe('["F1"]');
  });
});

describe('Factory Method: REPORT_WRITERS', () => {
  it.each(Object.values(OutputFormat))('tem um writer para o formato %s', (format) => {
    const writer: ReportWriter = REPORT_WRITERS[format]();

    expect(writer.format).toBe(format);
    expect(writer).toBeInstanceOf(FileReportWriter);
  });

  it('a configuração escolhe os formatos sem if nem switch', () => {
    const outputs = [OutputFormat.Markdown, OutputFormat.Json];

    const writers = outputs.map((format) => REPORT_WRITERS[format]());

    expect(writers[0]).toBeInstanceOf(MarkdownReportWriter);
    expect(writers[1]).toBeInstanceOf(JsonReportWriter);
  });
});
