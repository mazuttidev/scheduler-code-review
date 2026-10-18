import type { CodeHostKind } from './enums.js';

export type MergeRequestState = 'opened' | 'closed' | 'locked' | 'merged';

export interface DiffRefs {
  readonly baseSha: string;
  readonly startSha: string;
  readonly headSha: string;
}

export interface MergeRequestRef {
  readonly host: CodeHostKind;
  readonly projectId: number;
  readonly projectPath: string;
  readonly iid: number;
  readonly title: string;
  readonly description: string;
  readonly webUrl: string;
  readonly state: MergeRequestState;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly diffRefs: DiffRefs;
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffContext {
  readonly patch: string;
  readonly files: readonly ChangedFile[];
  readonly bytes: number;
  /**
   * Commits realmente comparados. Se o MR recebeu um push depois da consulta à
   * API, diferem dos `diffRefs` do `MergeRequestRef`, e são estes que valem.
   */
  readonly baseSha: string;
  readonly headSha: string;
}
