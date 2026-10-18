import { mkdir } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from '../../shared/fs.js';

import { GitClient } from './worktree-manager.js';

/** Repositório git criado para a demonstração e para os testes de integração. */
export interface DemoRepository {
  readonly path: string;
  readonly targetBranch: string;
  readonly sourceBranch: string;
  readonly mergeRequestIid: number;
  /** Commit de `main`, de onde a branch de feature saiu. */
  readonly baseSha: string;
  /** Commit apontado por `refs/merge-requests/1/head`. */
  readonly headSha: string;
}

const AUTHOR = { name: 'nightly-review demo', email: 'demo@nightly-review.test' };
const COMMIT_DATE = '2026-10-01T12:00:00Z';

/**
 * Cliente git que ignora a configuração global da máquina (assinatura de
 * commits, hooks, templates) e usa autor e data fixos. Com isso, os commits
 * de demonstração têm sempre os mesmos SHAs.
 */
export function isolatedGitClient(): GitClient {
  return new GitClient({
    env: {
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_AUTHOR_DATE: COMMIT_DATE,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      GIT_COMMITTER_DATE: COMMIT_DATE,
    },
  });
}

const PRICES = `export const PRICES: Record<string, number> = {
  cafe: 12,
  pao: 8,
  queijo: 30,
};
`;

const CART_ON_MAIN = `import { PRICES } from './pricing.js';

export function cartTotal(items: readonly string[]): number {
  return items.reduce((total, item) => total + (PRICES[item] ?? 0), 0);
}
`;

const CART_ON_FEATURE = `import { discountRate } from './discount.js';
import { PRICES } from './price-table.js';

export function cartTotal(items: readonly string[], coupon = 0): number {
  const total = items.reduce((sum, item) => sum + (PRICES[item] ?? 0), 0);
  return total * (1 - discountRate(total, coupon));
}
`;

// O bug da demonstração: com o carrinho vazio, `total` é 0 e a divisão dá NaN.
const DISCOUNT = `export function discountRate(total: number, coupon: number): number {
  return Math.min(coupon / total, 0.5);
}
`;

const README = `# Loja de demonstração

Repositório criado pelo nightly-review para a execução offline.
`;

/**
 * Cria em `directory` um repositório com `main`, a branch `feature/desconto`
 * (um arquivo novo, um modificado e um renomeado) e a ref
 * `refs/merge-requests/1/head`, como um MR do GitLab.
 */
export async function createDemoRepository(
  directory: string,
  git: GitClient = isolatedGitClient(),
): Promise<DemoRepository> {
  const write = (file: string, content: string): Promise<void> =>
    writeFileAtomic(join(directory, file), content, { mode: 0o644, directoryMode: 0o755 });
  const commit = (subject: string, body?: string): Promise<string> =>
    git.run(
      [
        'commit',
        '--no-gpg-sign',
        '--no-verify',
        '--message',
        subject,
        ...(body ? ['--message', body] : []),
      ],
      directory,
    );

  await mkdir(directory, { recursive: true });
  await git.run(['init', '--initial-branch=main'], directory);

  await write('README.md', README);
  await write('src/pricing.ts', PRICES);
  await write('src/cart.ts', CART_ON_MAIN);
  await git.run(['add', '--all'], directory);
  await commit('Carrinho: total dos itens');

  await git.run(['checkout', '-b', 'feature/desconto'], directory);
  await git.run(['mv', 'src/pricing.ts', 'src/price-table.ts'], directory);
  await write('src/cart.ts', CART_ON_FEATURE);
  await write('src/discount.ts', DISCOUNT);
  await git.run(['add', '--all'], directory);
  await commit('Desconto por cupom', 'Aplica o cupom ao total do carrinho, limitado a 50%.');

  await git.run(['update-ref', 'refs/merge-requests/1/head', 'HEAD'], directory);
  await git.run(['checkout', 'main'], directory);

  return {
    path: directory,
    targetBranch: 'main',
    sourceBranch: 'feature/desconto',
    mergeRequestIid: 1,
    baseSha: (await git.run(['rev-parse', 'main'], directory)).trim(),
    headSha: (await git.run(['rev-parse', 'refs/merge-requests/1/head'], directory)).trim(),
  };
}
