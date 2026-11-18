import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { listDirectories, listFiles, type Violation } from '../harness';
import {
  exportedClasses,
  ENTITY_FILE,
  exportedNames,
  isErrorClass,
  moduleImports,
  parse,
  target,
  type ModuleImport,
} from './syntax';

/** Syntax-only layout rules of `architecture:api` (backend.md §2 and §3, ADR 0003). */
export const LAYOUT_RULES = [
  'api-application-no-http-decorators',
  'api-entry-points-no-ports-or-infrastructure',
  'api-features-no-feature-imports',
  'api-collaborators-no-feature-imports',
  'api-production-no-test-imports',
  'api-contracts-only-index-and-events',
  'api-no-shared-common-utils-helpers-directory',
  'api-entities-are-classes-with-non-public-constructors',
  'api-no-domain-services-directory',
];

/**
 * npm packages `application/` never imports: request-schema and OpenAPI libraries, an HTTP
 * server, queue and scheduler APIs (backend.md §3 rule 2). Checked by a dependency rule.
 */
export const APPLICATION_FORBIDDEN_PACKAGES = [
  'nestjs-zod',
  '@nestjs/swagger',
  'class-validator',
  'class-transformer',
  'express',
  '@nestjs/platform-express',
  'bullmq',
  '@nestjs/bullmq',
  '@nestjs/schedule',
  'node-cron',
  'cron',
];

/** Controller, route and parameter decorators of `@nestjs/common`: HTTP knowledge. */
const HTTP_DECORATORS = new Set([
  'Controller',
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Options',
  'Head',
  'All',
  'Sse',
  'Body',
  'Param',
  'Query',
  'Headers',
  'Header',
  'Req',
  'Request',
  'Res',
  'Response',
  'Ip',
  'HostParam',
  'Session',
  'UploadedFile',
  'UploadedFiles',
  'HttpCode',
  'Redirect',
  'Render',
  'UseGuards',
  'UseInterceptors',
  'UseFilters',
  'UsePipes',
]);

const APPLICATION_FILE = /^src\/modules\/[^/]+\/application\//;

/** `src/modules/<module>/application/features/<feature>/…` (not the tests of a feature). */
const FEATURE_FILE = /^src\/modules\/([^/]+)\/application\/features\/([^/]+)\/(?!__tests__\/)/;
/** A file directly in a module's `application/` folder: a collaborator. */
const COLLABORATOR_FILE = /^src\/modules\/[^/]+\/application\/[^/]+\.tsx?$/;
const FEATURE_PATH = /^src\/modules\/([^/]+)\/application\/features\/([^/]+)\//;
const ENTRY_POINT_FILE = /^src\/modules\/[^/]+\/entry-points\//;
const INFRASTRUCTURE_FILE = /^src\/modules\/[^/]+\/infrastructure\//;
/**
 * A repository interface or port file, at any depth (ports may sit in sub-folders). The test
 * helpers under `__tests__/` (in-memory fakes) are not interfaces: production code importing one is
 * `api-production-no-test-imports`.
 */
const REPOSITORY_OR_PORT_FILE =
  /^src\/modules\/[^/]+\/(domain\/repositories|application\/ports)\/(?!(.*\/)?__tests__\/).+\.ts$/;
/** A domain error class: the one thing an entry point may take from a repository or port file. */
const ERROR_NAME = /Error$/;
/** Names that, as a directory inside a business module, are generic dumping grounds. */
const FORBIDDEN_DIRECTORIES = new Set(['shared', 'common', 'utils', 'helpers']);
const HTTP_SHARED_DIRECTORY = /^src\/modules\/[^/]+\/entry-points\/http\/shared$/;

export function layoutViolations(baseDir: string): Violation[] {
  const files = listFiles(baseDir, 'src/modules').filter(
    (path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts'),
  );
  return [
    ...files
      .filter((path) => APPLICATION_FILE.test(path))
      .flatMap((path) => applicationDecoratorViolations(baseDir, path)),
    ...files
      .filter((path) => ENTRY_POINT_FILE.test(path))
      .flatMap((path) => entryPointViolations(baseDir, path)),
    ...files.flatMap((path) => featureImportViolations(baseDir, path)),
    ...files.flatMap((path) => collaboratorImportViolations(baseDir, path)),
    ...files.flatMap((path) => testImportViolations(baseDir, path)),
    ...files.flatMap((path) => entityClassViolations(baseDir, path)),
    ...contractsViolations(baseDir),
    ...directoryViolations(baseDir),
    ...domainServicesViolations(baseDir),
  ];
}

/**
 * `application/` imports no HTTP decorator of `@nestjs/common`; a namespace import is refused too,
 * since its members cannot be checked. Other libraries are covered by the dependency rule
 * `api-application-no-http-queue-scheduler-libraries`.
 */
function applicationDecoratorViolations(baseDir: string, path: string): Violation[] {
  return moduleImports(baseDir, path)
    .filter((entry) => entry.specifier === '@nestjs/common')
    .flatMap((entry) => entry.names.filter((name) => name === '*' || HTTP_DECORATORS.has(name)))
    .map((name) => ({
      rule: 'api-application-no-http-decorators',
      from: path,
      to: `@nestjs/common ${name}`,
    }));
}

/**
 * An entry point imports nothing from `infrastructure/`, and from a repository or port file only
 * error classes. A port re-exported by another file (a handler, say) is the same import in
 * disguise.
 */
function entryPointViolations(baseDir: string, path: string): Violation[] {
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    if (!to) return [];
    if (INFRASTRUCTURE_FILE.test(to)) {
      return [{ rule: 'api-entry-points-no-ports-or-infrastructure', from: path, to }];
    }
    if (REPOSITORY_OR_PORT_FILE.test(to)) {
      return entry.names
        .filter((name) => !ERROR_NAME.test(name))
        .map((name) => ({
          rule: 'api-entry-points-no-ports-or-infrastructure',
          from: path,
          to: `${to} ${name}`,
        }));
    }
    return portReexports(baseDir, to)
      .filter(({ name }) => entry.names.includes('*') || entry.names.includes(name))
      .map(({ name, origin }) => ({
        rule: 'api-entry-points-no-ports-or-infrastructure',
        from: path,
        to: `${to} ${name} (re-exported from ${origin})`,
      }));
  });
}

/**
 * The non-error names `file` exposes that come from a repository interface or port file, through
 * `export { X } from`, `export * from`, or an import followed by `export { X }`, followed through
 * relative files. `*` stands for names that cannot be listed (`export *`, `export * as ns`).
 */
function portReexports(
  baseDir: string,
  file: string,
  chain: string[] = [],
): { name: string; origin: string }[] {
  if (chain.includes(file) || !existsSync(join(baseDir, file))) return [];
  const source = parse(baseDir, file);
  const imported = new Map<string, { specifier: string; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imported.set(element.name.text, {
          specifier: statement.moduleSpecifier.text,
          name: (element.propertyName ?? element.name).text,
        });
      }
    }
  }
  /** What exposing `name` of the file at `specifier` leads to, if it is a port or repository. */
  const through = (specifier: string, name: string): string | undefined => {
    const to = target(file, specifier);
    if (!to) return undefined;
    if (REPOSITORY_OR_PORT_FILE.test(to)) return ERROR_NAME.test(name) ? undefined : to;
    const inner = portReexports(baseDir, to, [...chain, file]).filter(
      (candidate) => candidate.name === name || candidate.name === '*',
    );
    return inner[0]?.origin;
  };
  const found: { name: string; origin: string }[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    const clause = statement.exportClause;
    if (specifier && (!clause || ts.isNamespaceExport(clause))) {
      const to = target(file, specifier);
      if (!to) continue;
      const inner = REPOSITORY_OR_PORT_FILE.test(to)
        ? existsSync(join(baseDir, to))
          ? exportedNames(parse(baseDir, to))
              .filter((name) => !ERROR_NAME.test(name))
              .map((name) => ({ name, origin: to }))
          : []
        : portReexports(baseDir, to, [...chain, file]);
      if (clause) {
        // `export * as ns`: one name, `ns`, for everything the file leads to.
        if (inner[0]) found.push({ name: clause.name.text, origin: inner[0].origin });
      } else {
        // `export *`: the file's own non-error names, so an import of any of them is seen.
        found.push(...inner);
      }
    } else if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        const from = (element.propertyName ?? element.name).text;
        const binding = specifier ? { specifier, name: from } : imported.get(from);
        const origin = binding ? through(binding.specifier, binding.name) : undefined;
        if (origin) found.push({ name: element.name.text, origin });
      }
    }
  }
  return found;
}

/**
 * A feature file imports nothing from another feature folder. Tests are not checked: a round-trip
 * test may build the handler that produces what the handler under test reads.
 */
function featureImportViolations(baseDir: string, path: string): Violation[] {
  const own = FEATURE_FILE.exec(path);
  if (!own) return [];
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    const other = to ? FEATURE_PATH.exec(to) : null;
    if (!to || !other || other[1] !== own[1] || other[2] === own[2]) return [];
    return [{ rule: 'api-features-no-feature-imports', from: path, to }];
  });
}

/**
 * A collaborator, a file directly in `application/`, imports nothing from `application/features/`
 * (rule 3): it is shared logic that features call, so a feature reached from it would turn the
 * dependency around and make one feature depend on another through it. Its tests are not checked.
 */
function collaboratorImportViolations(baseDir: string, path: string): Violation[] {
  if (!COLLABORATOR_FILE.test(path) || /\.test\.tsx?$/.test(path)) return [];
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    return to && FEATURE_PATH.test(to)
      ? [{ rule: 'api-collaborators-no-feature-imports', from: path, to }]
      : [];
  });
}

/** A test file: inside a `__tests__/` directory, or named `*.test.ts(x)`. */
const TEST_FILE = /(^|\/)__tests__\/|\.test\.tsx?$/;

/**
 * No production file of a module imports a test file (a file in `__tests__/` or `*.test.ts`),
 * so test helpers and fakes never reach the application. Tests may import tests.
 */
function testImportViolations(baseDir: string, path: string): Violation[] {
  if (TEST_FILE.test(path)) return [];
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    return to && TEST_FILE.test(to)
      ? [{ rule: 'api-production-no-test-imports', from: path, to }]
      : [];
  });
}

/** `contracts/` holds `index.ts` and, below `events/`, integration events: nothing else. */
function contractsViolations(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const contracts = `src/modules/${module}/contracts/`;
    return listFiles(baseDir, contracts)
      .filter((file) => {
        const inside = file.slice(contracts.length);
        return inside !== 'index.ts' && !inside.startsWith('events/');
      })
      .map((file) => ({ rule: 'api-contracts-only-index-and-events', from: file }));
  });
}

/**
 * No directory named `shared`, `common`, `utils` or `helpers` inside a business module
 * (rule 3), except exactly `entry-points/http/shared/`, which the layout defines.
 */
function directoryViolations(baseDir: string): Violation[] {
  const directories = new Set<string>();
  for (const file of listFiles(baseDir, 'src/modules')) {
    const parts = file.split('/');
    for (let depth = 4; depth < parts.length; depth++) {
      directories.add(parts.slice(0, depth).join('/'));
    }
  }
  return [...directories]
    .filter((directory) =>
      FORBIDDEN_DIRECTORIES.has(directory.slice(directory.lastIndexOf('/') + 1)),
    )
    .filter((directory) => !HTTP_SHARED_DIRECTORY.test(directory))
    .sort()
    .map((directory) => ({
      rule: 'api-no-shared-common-utils-helpers-directory',
      from: `${directory}/`,
    }));
}

/**
 * No module has a `domain/services/` directory, even an empty one (rule 5): a rule that seems to
 * belong to no object means a concept is missing from the model, so it goes on the entity, policy
 * or value object it is about. A folder that is permitted and nearly empty gets filled again.
 */
function domainServicesViolations(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules')
    .filter((module) =>
      listDirectories(baseDir, `src/modules/${module}/domain`).includes('services'),
    )
    .map((module) => ({
      rule: 'api-no-domain-services-directory',
      from: `src/modules/${module}/domain/services/`,
    }));
}

/**
 * An entity file exports a class with a `private` or `protected` constructor, so only its factories
 * build it. Error classes are not entities; a plain record belongs in `domain/value-objects/`.
 */
function entityClassViolations(baseDir: string, path: string): Violation[] {
  const match = ENTITY_FILE.exec(path);
  if (!match) return [];
  const entityClasses = exportedClasses(parse(baseDir, path)).filter(
    (exported) => !isErrorClass(exported),
  );
  const sealed =
    entityClasses.length > 0 &&
    entityClasses.every((exported) => hasNonPublicConstructor(exported.node));
  return sealed
    ? []
    : [{ rule: 'api-entities-are-classes-with-non-public-constructors', from: path }];
}

function hasNonPublicConstructor(declaration: ts.ClassLikeDeclaration): boolean {
  const constructors = declaration.members.filter(ts.isConstructorDeclaration);
  return (
    constructors.length > 0 &&
    constructors.every((constructor) =>
      ts
        .getModifiers(constructor)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword,
        ),
    )
  );
}
