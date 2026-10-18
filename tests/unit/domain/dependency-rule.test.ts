import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DOMAIN_DIR = join(import.meta.dirname, '../../../src/domain');
// Cobre `import … from`, `export … from`, `import 'x'`, `import('x')` e `require('x')`.
const IMPORT_SOURCE =
  /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function importedModules(file: string): string[] {
  const source = readFileSync(join(DOMAIN_DIR, file), 'utf8');
  return [...source.matchAll(IMPORT_SOURCE)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

// Regra de dependência da ARCHITECTURE §5: o domínio não conhece outras camadas.
describe('src/domain', () => {
  const files = readdirSync(DOMAIN_DIR, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );

  it('tem os arquivos do domínio', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s só importa da própria pasta ou do zod', (file) => {
    const outside = importedModules(file).filter(
      (module) => module !== 'zod' && !/^\.\/[^/]+\.js$/.test(module),
    );

    expect(outside).toEqual([]);
  });
});
