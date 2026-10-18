import type {
  FormattedPrompt,
  PromptFormatter,
} from '../../../application/ports/review-provider.js';
import type { ReviewPrompt } from '../../../application/prompt/review-prompt.js';

const SECTION_TAGS = [
  'instructions',
  'task',
  'title',
  'description',
  'business_rules',
  'rule',
  'acceptance_criteria',
  'criterion',
  'merge_request',
  'changed_files',
  'file',
  'diff',
  'notes',
  'note',
] as const;
type SectionTag = (typeof SECTION_TAGS)[number];

const CLOSING_TAG = new RegExp(`</(${SECTION_TAGS.join('|')})\\s*>`, 'gi');

type Attributes = Readonly<Record<string, string | number>>;

/**
 * Abstract Factory (ConcreteProduct): prompt em seções delimitadas por tags
 * XML, formato a que o Claude responde melhor. O schema de saída não entra no
 * texto: o Agent SDK o recebe pela opção `outputFormat`.
 */
export class XmlSectionsPromptFormatter implements PromptFormatter {
  format(prompt: ReviewPrompt): FormattedPrompt {
    const { task, mergeRequest, diff, notes } = prompt;
    const sections = [
      leaf('instructions', prompt.instructions.trim()),
      group(
        'task',
        [
          leaf('title', task.title),
          leaf('description', task.description),
          group(
            'business_rules',
            task.businessRules.map((rule) => leaf('rule', rule)),
          ),
          group(
            'acceptance_criteria',
            task.acceptanceCriteria.map((criterion) => leaf('criterion', criterion)),
          ),
        ],
        { id: task.id, url: task.url },
      ),
      group(
        'merge_request',
        [leaf('title', mergeRequest.title), leaf('description', mergeRequest.description)],
        {
          iid: mergeRequest.iid,
          url: mergeRequest.webUrl,
          source_branch: mergeRequest.sourceBranch,
          target_branch: mergeRequest.targetBranch,
        },
      ),
      group(
        'changed_files',
        diff.files.map(
          (file) =>
            `<file${attributes({
              path: file.path,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
            })}/>`,
        ),
      ),
      leaf('diff', diff.patch),
      ...(notes.length > 0
        ? [
            group(
              'notes',
              notes.map((note) => leaf('note', note)),
            ),
          ]
        : []),
    ];
    return { system: prompt.systemRules.trim(), user: sections.join('\n\n') };
  }
}

/** Seção com texto. O conteúdo de terceiros não consegue fechar a tag por conta própria. */
function leaf(name: SectionTag, content: string): string {
  return `<${name}>\n${content.replace(CLOSING_TAG, '&lt;/$1>')}\n</${name}>`;
}

/** Seção que só contém outras seções, já montadas. */
function group(name: SectionTag, children: readonly string[], attrs: Attributes = {}): string {
  return [`<${name}${attributes(attrs)}>`, ...children, `</${name}>`].join('\n');
}

function attributes(values: Attributes): string {
  return Object.entries(values)
    .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
    .join('');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
