import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSource } from '../config/app-config.js';
import {
  Confidence,
  CriterionStatus,
  FindingCategory,
  Severity,
  Verdict,
} from '../domain/enums.js';
import type { ReviewOutput } from '../domain/review-output.js';
import { LocalCodeHost } from '../infrastructure/code-hosts/local-code-host.js';
import { createDemoRepository, isolatedGitClient } from '../infrastructure/git/demo-repository.js';
import type { GitClient } from '../infrastructure/git/worktree-manager.js';
import { writeFileAtomic } from '../shared/fs.js';

/** Tudo de que a demonstração offline precisa: repositório, tarefas e configuração. */
export interface DemoScenario {
  /** Pasta temporária com o repositório, o arquivo de tarefas e os dados da execução. */
  readonly root: string;
  readonly source: ConfigSource;
  readonly git: GitClient;
  /** Review que o provedor falso devolve: aponta o bug proposital do MR. */
  readonly output: ReviewOutput;
}

const PROJECT_PATH = 'demo/loja';
const CRITERIA = ['Um cupom válido reduz o total.', 'O carrinho vazio não quebra.'] as const;

const DEMO_REVIEW: ReviewOutput = {
  summary:
    'O MR aplica o cupom ao total, mas a taxa de desconto divide pelo total do carrinho, que é zero quando ele está vazio.',
  verdict: Verdict.ChangesRequested,
  acceptanceCriteria: [
    { criterion: CRITERIA[0], status: CriterionStatus.Met, notes: 'Coberto por cartTotal.' },
    { criterion: CRITERIA[1], status: CriterionStatus.NotMet, notes: 'Veja o achado F1.' },
  ],
  findings: [
    {
      id: 'F1',
      severity: Severity.Major,
      category: FindingCategory.Bug,
      file: 'src/discount.ts',
      line: 2,
      title: 'Divisão por zero com o carrinho vazio',
      comment:
        'Com o carrinho vazio, total é 0 e coupon / total resulta em NaN; cartTotal passa a devolver NaN.',
      suggestion: 'Devolva 0 quando total for 0, antes de dividir.',
      confidence: Confidence.High,
    },
    {
      id: 'F2',
      severity: Severity.Minor,
      category: FindingCategory.Tests,
      file: 'src/discount.ts',
      line: null,
      title: 'Sem testes para o desconto',
      comment: 'O MR não traz testes para discountRate nem para o limite de 50%.',
      suggestion: null,
      confidence: Confidence.Medium,
    },
  ],
};

/**
 * Cria numa pasta temporária o repositório de demonstração e um arquivo com
 * duas tarefas: uma com o MR e outra sem link, para mostrar o pulo.
 */
export async function prepareDemoScenario(parentDirectory: string = tmpdir()): Promise<DemoScenario> {
  const root = await mkdtemp(join(parentDirectory, 'nightly-review-demo-'));
  const git = isolatedGitClient();
  const repository = await createDemoRepository(join(root, 'origin'), git);
  const codeHost = new LocalCodeHost(git, {
    repositoryPath: repository.path,
    projectPath: PROJECT_PATH,
    targetBranch: repository.targetBranch,
  });

  const tasksPath = join(root, 'tasks.json');
  const tasks = [
    {
      id: 'DEMO-1',
      title: 'Aplicar desconto por cupom no carrinho',
      description: 'O total do carrinho deve considerar o cupom informado pelo cliente.',
      businessRules: ['O desconto nunca passa de 50% do total.'],
      acceptanceCriteria: CRITERIA,
      mergeRequestUrl: codeHost.mergeRequestUrl(repository.mergeRequestIid),
    },
    {
      id: 'DEMO-2',
      title: 'Exportar o pedido em PDF',
      description: 'Tarefa ainda sem merge request vinculado.',
    },
  ];
  await writeFileAtomic(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);

  const settings = {
    dataDir: join(root, 'data'),
    taskSource: { kind: 'json-file', jsonFile: { path: tasksPath } },
    codeHost: {
      kind: 'local',
      repositoryPath: repository.path,
      projectPath: PROJECT_PATH,
      targetBranch: repository.targetBranch,
    },
    provider: { kind: 'fake' },
  };
  return { root, git, output: DEMO_REVIEW, source: { env: {}, readSettings: () => settings } };
}
