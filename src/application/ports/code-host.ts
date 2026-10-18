import type { CodeHostKind } from '../../domain/enums.js';
import type { MergeRequestRef } from '../../domain/merge-request.js';

/** Adapter (Target): a plataforma que hospeda o código e os merge requests. */
export interface CodeHost {
  readonly kind: CodeHostKind;
  /** Resolve o link do MR. Recusa links de hosts que não sejam o configurado. */
  resolveMergeRequest(url: string): Promise<MergeRequestRef>;
  /** URL de clone do projeto, derivada da configuração e nunca do link da tarefa. */
  cloneUrl(projectPath: string): string;
  /** Ref que aponta para o head do MR, como `refs/merge-requests/<iid>/head`. */
  mergeRequestRef(iid: number): string;
}
