import type { OutputFormat } from '../../domain/enums.js';
import type { ReviewReport } from '../../domain/review-report.js';

/** Grava o relatório de um review num formato de saída. */
export interface ReportWriter {
  readonly format: OutputFormat;
  /** Grava o relatório em `directory` e devolve o caminho do arquivo. */
  write(report: ReviewReport, directory: string): Promise<string>;
  /** Apaga um arquivo gravado. Não falha se ele já não existir. */
  remove(filePath: string): Promise<void>;
}
