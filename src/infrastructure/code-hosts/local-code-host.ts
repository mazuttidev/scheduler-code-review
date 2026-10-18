import type { CodeHost } from '../../application/ports/code-host.js';
import { CodeHostKind } from '../../domain/enums.js';
import { InvalidInputError, NotFoundError } from '../../domain/errors.js';
import type { MergeRequestRef } from '../../domain/merge-request.js';
import type { GitClient } from '../git/worktree-manager.js';

/** Origem fictícia dos links de MR do host local. Nunca é acessada pela rede. */
export const LOCAL_CODE_HOST_ORIGIN = 'http://local.nightly-review.test';

export interface LocalCodeHostSettings {
  /** Repositório git local que faz o papel de servidor. */
  readonly repositoryPath: string;
  readonly projectPath: string;
  readonly targetBranch: string;
}

/**
 * Adapter (Adapter): faz um repositório git local se comportar como uma
 * plataforma de código. O MR é a ref `refs/merge-requests/<iid>/head`, e os
 * seus dados vêm do commit apontado por ela. Serve à demonstração e aos testes.
 */
export class LocalCodeHost implements CodeHost {
  readonly kind = CodeHostKind.Local;

  constructor(
    private readonly git: GitClient,
    private readonly settings: LocalCodeHostSettings,
  ) {}

  /** Link que este host aceita para o MR, no mesmo formato do GitLab. */
  mergeRequestUrl(iid: number): string {
    return `${LOCAL_CODE_HOST_ORIGIN}/${this.settings.projectPath}/-/merge_requests/${String(iid)}`;
  }

  async resolveMergeRequest(url: string): Promise<MergeRequestRef> {
    const iid = this.parseMergeRequestUrl(url);
    const { repositoryPath, projectPath, targetBranch } = this.settings;
    const ref = this.mergeRequestRef(iid);

    const found = await this.git.check(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      repositoryPath,
    );
    if (!found) throw new NotFoundError('Merge request inexistente', { iid, projectPath });

    const headSha = await this.read(['rev-parse', '--verify', `${ref}^{commit}`]);
    const baseSha = await this.read(['merge-base', `refs/heads/${targetBranch}`, headSha]);
    const [title = '', description = ''] = (
      await this.read(['log', '-1', '--format=%s%x00%b', headSha])
    ).split('\0');
    const [sourceBranch = `mr-${String(iid)}`] = (
      await this.read(['for-each-ref', '--points-at', headSha, '--format=%(refname:short)', 'refs/heads'])
    )
      .split('\n')
      .filter((branch) => branch !== '' && branch !== targetBranch);

    return {
      host: this.kind,
      projectId: 1,
      projectPath,
      iid,
      title,
      description: description.trim(),
      webUrl: this.mergeRequestUrl(iid),
      state: 'opened',
      sourceBranch,
      targetBranch,
      diffRefs: { baseSha, startSha: baseSha, headSha },
    };
  }

  cloneUrl(projectPath: string): string {
    if (projectPath !== this.settings.projectPath) {
      throw new InvalidInputError('Projeto desconhecido para o host local', { projectPath });
    }
    return this.settings.repositoryPath;
  }

  mergeRequestRef(iid: number): string {
    return `refs/merge-requests/${String(iid)}/head`;
  }

  private parseMergeRequestUrl(url: string): number {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (cause) {
      throw new InvalidInputError('Link de MR inválido', { url }, { cause });
    }
    if (parsed.origin !== LOCAL_CODE_HOST_ORIGIN) {
      throw new InvalidInputError('O link do MR não é do host configurado', {
        url,
        expectedOrigin: LOCAL_CODE_HOST_ORIGIN,
      });
    }
    const prefix = `/${this.settings.projectPath}/-/merge_requests/`;
    const iid = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : '';
    if (!/^[1-9]\d*$/.test(iid)) {
      throw new InvalidInputError('O link não aponta para um MR do projeto configurado', { url });
    }
    return Number(iid);
  }

  private async read(args: readonly string[]): Promise<string> {
    return (await this.git.run(args, this.settings.repositoryPath)).trim();
  }
}
