import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  READ_ONLY_TOOLS,
  createReadOnlyGuard,
  isReadOnlyTool,
} from '../../src/infrastructure/providers/claude/read-only-guard.js';

const ALLOWED = {};
const DENIED = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } };

describe('createReadOnlyGuard', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  /** Chama o hook como o SDK chama antes de cada ferramenta. */
  async function decide(toolName: string, toolInput: unknown): Promise<HookJSONOutput> {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      session_id: 'sessao-de-teste',
      transcript_path: join(root, 'transcript.jsonl'),
      cwd: workspace,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'tool-1',
    };
    return createReadOnlyGuard(workspace)(input, 'tool-1', { signal: new AbortController().signal });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nightly-review-guard-'));
    workspace = join(root, 'worktree');
    outside = join(root, 'segredos');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(workspace, 'src', 'discount.ts'), 'export const x = 1;\n');
    await writeFile(join(outside, 'id_rsa'), 'chave privada de mentira\n');
    // O que um MR malicioso poderia trazer: symlinks apontando para fora.
    await symlink(join(outside, 'id_rsa'), join(workspace, 'config.txt'));
    await symlink(outside, join(workspace, 'vendor'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('permite ler dentro do worktree', () => {
    it.each([
      ['Read', 'caminho absoluto', () => ({ file_path: join(workspace, 'src', 'discount.ts') })],
      ['Read', 'caminho relativo', () => ({ file_path: 'src/discount.ts' })],
      ['Read', 'arquivo que ainda não existe', () => ({ file_path: 'src/novo/arquivo.ts' })],
      ['Read', 'caminho com .. que continua dentro', () => ({ file_path: 'src/../src/discount.ts' })],
      ['Grep', 'sem caminho (a raiz do worktree)', () => ({ pattern: 'discountRate' })],
      ['Grep', 'pasta dentro', () => ({ pattern: 'TODO', path: 'src', glob: '**/*.ts' })],
      ['Glob', 'padrão relativo', () => ({ pattern: '**/*.ts' })],
      ['Glob', 'pasta dentro', () => ({ pattern: '*.ts', path: join(workspace, 'src') })],
    ])('%s com %s', async (toolName, _label, toolInput) => {
      expect(await decide(toolName, toolInput())).toEqual(ALLOWED);
    });
  });

  describe('nega ler fora do worktree', () => {
    it.each([
      ['Read', 'caminho absoluto fora', () => ({ file_path: join(outside, 'id_rsa') })],
      ['Read', 'arquivo do sistema', () => ({ file_path: '/etc/passwd' })],
      ['Read', 'caminho com ../', () => ({ file_path: '../segredos/id_rsa' })],
      ['Read', 'caminho no diretório do usuário', () => ({ file_path: '~/.ssh/id_rsa' })],
      ['Read', 'symlink de arquivo apontando para fora', () => ({ file_path: 'config.txt' })],
      ['Read', 'arquivo atrás de um symlink de pasta', () => ({ file_path: 'vendor/id_rsa' })],
      ['Read', 'a própria pasta pai', () => ({ file_path: '..' })],
      ['Grep', 'pasta fora', () => ({ pattern: 'BEGIN', path: outside })],
      ['Grep', 'filtro glob com ..', () => ({ pattern: 'BEGIN', glob: '../**' })],
      ['Glob', 'padrão com ..', () => ({ pattern: '../**/*' })],
      ['Glob', 'padrão absoluto', () => ({ pattern: '/etc/*' })],
      ['Glob', 'padrão no diretório do usuário', () => ({ pattern: '~/.ssh/*' })],
      ['Glob', 'pasta fora', () => ({ pattern: '*', path: outside })],
      ['Glob', 'pasta atrás de symlink', () => ({ pattern: '*', path: 'vendor' })],
    ])('%s com %s', async (toolName, _label, toolInput) => {
      expect(await decide(toolName, toolInput())).toMatchObject(DENIED);
    });
  });

  it.each(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'mcp__x__y'])(
    'nega a ferramenta %s, mesmo com um caminho dentro do worktree',
    async (toolName) => {
      const output = await decide(toolName, { file_path: join(workspace, 'src', 'discount.ts') });

      expect(output).toMatchObject(DENIED);
      expect(JSON.stringify(output)).toContain(`A ferramenta ${toolName} não é permitida no review`);
    },
  );

  it('ignora eventos que não são PreToolUse', async () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'sessao-de-teste',
      transcript_path: join(root, 'transcript.jsonl'),
      cwd: workspace,
      tool_name: 'Bash',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'tool-1',
    };

    const output = await createReadOnlyGuard(workspace)(input, 'tool-1', {
      signal: new AbortController().signal,
    });

    expect(output).toEqual(ALLOWED);
  });

  it('nega tudo quando o worktree não existe', async () => {
    const guard = createReadOnlyGuard(join(root, 'nao-existe'));
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      session_id: 'sessao-de-teste',
      transcript_path: join(root, 'transcript.jsonl'),
      cwd: root,
      tool_name: 'Read',
      tool_input: { file_path: 'a.ts' },
      tool_use_id: 'tool-1',
    };

    expect(await guard(input, 'tool-1', { signal: new AbortController().signal })).toMatchObject(
      DENIED,
    );
  });
});

describe('isReadOnlyTool', () => {
  it('reconhece só as três ferramentas de leitura', () => {
    expect(READ_ONLY_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(isReadOnlyTool('Read')).toBe(true);
    expect(isReadOnlyTool('read')).toBe(false);
    expect(isReadOnlyTool('Bash')).toBe(false);
  });
});
