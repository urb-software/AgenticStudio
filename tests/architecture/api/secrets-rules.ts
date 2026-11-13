import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { listFiles, type Violation } from '../harness';

/**
 * The SecretStore boundary (ADR 0001, docs/architecture/backend.md §2, Issue #57). Only
 * `platform/secrets/` handles ciphertext and the master key. The import side is enforced
 * with Dependency Cruiser rules in gate.ts; these source-level rules cover what an import
 * edge cannot show: the Prisma `secret` delegate reached through any database client, raw
 * SQL on the `secrets` table, and reads of `secretsKey` from the configuration.
 * Syntax only, like source-rules.ts, and tests are included: a test outside
 * `platform/secrets/` goes through the port as well.
 */
export const SECRETS_SOURCE_RULES = ['api-secret-model-in-secrets-only', 'api-secrets-key-reads'];

const SECRETS_DIR = /^src\/platform\/secrets\//;
const CONFIG_DIR = /^src\/platform\/config\//;
/** The Prisma delegate of the `Secret` model (`db.secret.findUnique`, `tx.secret`, `{ secret } = db`). */
const SECRET_DELEGATE = 'secret';
const SECRETS_KEY = 'secretsKey';
/** Raw SQL naming the table: `FROM secrets`, `INTO "secrets"`, `UPDATE secrets`, `TABLE secrets`. */
const SECRETS_TABLE_SQL = /\b(from|into|update|join|table)\s+(\w+\.)?"?secrets"?(?![\w-])/i;

export function secretsViolations(baseDir: string): Violation[] {
  return listFiles(baseDir, 'src')
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts'))
    .filter((path) => !SECRETS_DIR.test(path))
    .flatMap((path) => {
      const source = ts.createSourceFile(
        path,
        readFileSync(join(baseDir, path), 'utf8'),
        ts.ScriptTarget.Latest,
        // Parent links: a binding element is a read only inside an object binding pattern.
        true,
      );
      return [
        ...[...secretModelUses(source)].map((to) => ({
          rule: 'api-secret-model-in-secrets-only',
          from: path,
          to,
        })),
        ...(CONFIG_DIR.test(path)
          ? []
          : [...propertyReads(source, SECRETS_KEY)].map((to) => ({
              rule: 'api-secrets-key-reads',
              from: path,
              to,
            }))),
      ];
    });
}

/** The `secret` delegate or raw SQL on the `secrets` table. */
function secretModelUses(source: ts.SourceFile): Set<string> {
  const uses = propertyReads(source, SECRET_DELEGATE);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      SECRETS_TABLE_SQL.test(node.text)
    ) {
      uses.add('secrets table (raw SQL)');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/**
 * Reads of property `name` from any object: `x.name`, `x?.name`, `x['name']` and
 * destructuring `{ name } = x` / `{ name: y } = x`. Writing it in an object literal
 * (`{ name: value }`, as a test or the OpenAPI generator does to build a config) is not a read.
 */
function propertyReads(source: ts.SourceFile, name: string): Set<string> {
  const reads = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      reads.add(`.${name}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === name
    ) {
      reads.add(`['${name}']`);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const property = node.propertyName ?? node.name;
      if ((ts.isIdentifier(property) || ts.isStringLiteral(property)) && property.text === name) {
        reads.add(`{ ${name} }`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}
