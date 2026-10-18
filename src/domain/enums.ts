/** Gravidade de um achado do review. */
export enum Severity {
  Blocker = 'blocker',
  Major = 'major',
  Minor = 'minor',
  Nit = 'nit',
}

export enum FindingCategory {
  Bug = 'bug',
  Security = 'security',
  Performance = 'performance',
  Tests = 'tests',
  Readability = 'readability',
  Requirements = 'requirements',
}

export enum Confidence {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export enum CriterionStatus {
  Met = 'met',
  NotMet = 'not_met',
  Unclear = 'unclear',
}

export enum Verdict {
  Approve = 'approve',
  ChangesRequested = 'changes_requested',
  NeedsDiscussion = 'needs_discussion',
}

export enum TaskSourceKind {
  Notion = 'notion',
  JsonFile = 'json-file',
}

export enum CodeHostKind {
  GitLab = 'gitlab',
  Local = 'local',
}

export enum ProviderKind {
  Claude = 'claude',
  Fake = 'fake',
}

export enum OutputFormat {
  Json = 'json',
  Markdown = 'markdown',
}

/** Tipo do erro. É ele que decide a política de retentativa. */
export enum ErrorKind {
  RateLimit = 'rate_limit',
  Transient = 'transient',
  Timeout = 'timeout',
  InvalidOutput = 'invalid_output',
  InvalidInput = 'invalid_input',
  NotFound = 'not_found',
  Configuration = 'configuration',
  Unknown = 'unknown',
}

/** Motivo de uma tarefa ser pulada sem chamar a IA. */
export enum SkipReason {
  MissingMergeRequestLink = 'missing_mr_link',
  MergeRequestNotOpen = 'mr_not_open',
  AlreadyReviewed = 'already_reviewed',
  DiffTooLarge = 'diff_too_large',
  DryRun = 'dry_run',
}
