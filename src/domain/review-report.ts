import { Severity } from './enums.js';
import type { ProviderKind } from './enums.js';
import type { MergeRequestRef } from './merge-request.js';
import type { Finding, ReviewOutput } from './review-output.js';
import type { ReviewTask } from './review-task.js';

export interface ReviewStats {
  readonly findingsBySeverity: Readonly<Record<Severity, number>>;
  readonly durationMs: number;
  readonly turns?: number;
  readonly costUsd?: number;
}

/** Saída validada da IA mais os metadados que a aplicação já conhece. */
export interface ReviewReport {
  readonly runId: string;
  /** Instante da geração, em ISO 8601. */
  readonly generatedAt: string;
  readonly provider: ProviderKind;
  readonly task: Pick<ReviewTask, 'id' | 'title' | 'url' | 'source'>;
  readonly mergeRequest: Pick<
    MergeRequestRef,
    'iid' | 'title' | 'webUrl' | 'projectPath' | 'sourceBranch' | 'targetBranch'
  > & { readonly headSha: string };
  readonly output: ReviewOutput;
  readonly stats: ReviewStats;
}

export function countBySeverity(
  findings: readonly Pick<Finding, 'severity'>[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    [Severity.Blocker]: 0,
    [Severity.Major]: 0,
    [Severity.Minor]: 0,
    [Severity.Nit]: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
