import type { DiffContext, MergeRequestRef } from '../../domain/merge-request.js';

/** Cópia de trabalho isolada de um MR, onde o revisor lê o código. */
export interface Workspace {
  readonly path: string;
  readonly headSha: string;
  /** Clone base a que o worktree pertence. */
  readonly repositoryPath: string;
}

export interface WorkspaceManager {
  /**
   * Atualiza o clone base e calcula o diff do MR, sem checkout. O `DiffContext`
   * traz os SHAs realmente comparados, que podem diferir dos da API se o MR
   * recebeu um push nesse meio-tempo.
   */
  fetchChanges(mr: MergeRequestRef): Promise<DiffContext>;
  /** Cria o worktree em `mr.diffRefs.headSha`. Supõe que `fetchChanges` já rodou. */
  prepare(mr: MergeRequestRef): Promise<Workspace>;
  /** Remove o worktree. Não falha se ele já não existir. */
  dispose(workspace: Workspace): Promise<void>;
}
