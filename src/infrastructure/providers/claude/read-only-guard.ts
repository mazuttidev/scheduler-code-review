import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/** As únicas ferramentas que existem na sessão de review. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];

export function isReadOnlyTool(name: string): name is ReadOnlyTool {
  return READ_ONLY_TOOLS.some((tool) => tool === name);
}

/** Campo da entrada de cada ferramenta que diz onde ela vai ler. */
const PATH_FIELD: Readonly<Record<ReadOnlyTool, string>> = {
  Read: 'file_path',
  Grep: 'path',
  Glob: 'path',
};

/**
 * Hook `PreToolUse` que só deixa ler dentro do worktree.
 *
 * Roda antes de qualquer regra de permissão, inclusive para as ferramentas
 * autoaprovadas, e o seu `deny` vale em qualquer modo. Por isso a checagem
 * está aqui, e não em `canUseTool`, que nem é consultado para `Read`.
 */
export function createReadOnlyGuard(workspaceRoot: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const { tool_name: toolName, tool_input: toolInput } = input;
    if (!isReadOnlyTool(toolName)) {
      return deny(`A ferramenta ${toolName} não é permitida no review`);
    }

    // Padrões de busca: o de Glob e o filtro `glob` do Grep.
    const pattern = readString(toolInput, toolName === 'Grep' ? 'glob' : 'pattern');
    if (toolName !== 'Read' && pattern !== undefined && escapesRoot(pattern)) {
      return deny('Padrão de busca fora do worktree');
    }

    const requested = readString(toolInput, PATH_FIELD[toolName]) ?? workspaceRoot;
    return (await isInside(workspaceRoot, requested))
      ? {}
      : deny('Acesso fora do worktree bloqueado');
  };
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function readString(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function escapesRoot(pattern: string): boolean {
  return (
    isAbsolute(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..')
  );
}

/**
 * Compara os caminhos reais da raiz e do alvo: um symlink dentro do MR que
 * aponta para `~/.ssh` é barrado, porque o alvo real fica fora da raiz.
 */
async function isInside(workspaceRoot: string, requested: string): Promise<boolean> {
  if (requested.startsWith('~')) return false;
  try {
    const root = await realpath(workspaceRoot);
    const target = await realpathOfExistingPart(resolve(root, requested));
    const fromRoot = relative(root, target);
    return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
  } catch {
    // Sem conseguir resolver o caminho, não há como garantir que ele é seguro.
    return false;
  }
}

/** Resolve os symlinks do trecho que existe; o resto do caminho é acrescentado como está. */
async function realpathOfExistingPart(path: string): Promise<string> {
  let existing = path;
  let missing = '';
  for (;;) {
    try {
      return join(await realpath(existing), missing);
    } catch (error) {
      const parent = dirname(existing);
      if (!isNotFound(error) || parent === existing) throw error;
      missing = join(basename(existing), missing);
      existing = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
