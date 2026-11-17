import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { listDirectories, listFiles, type Violation } from '../harness';

/**
 * Layout rules of `architecture:api` that follow from the approved module layout
 * (docs/architecture/backend.md §2 and §3, ADR 0003, Issue #162). Syntax and file tree only:
 * each file is parsed on its own, without type checking, so the rules work on fixtures.
 */
export const LAYOUT_RULES = [
  'api-application-no-http-decorators',
  'api-entry-points-no-ports-or-infrastructure',
  'api-contracts-only-index-and-events',
  'api-no-shared-common-utils-helpers-directory',
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

/**
 * The one pinned exemption of `api-entry-points-no-ports-or-infrastructure`: the live log
 * stream's endpoint injects two ports itself. Issue #166 moves that out of the endpoint and
 * removes this list. Any other file importing these ports, and any other port import in this
 * file, fails.
 */
const PINNED_ENTRY_POINT_PORT_IMPORTS: { from: string; to: string }[] = [
  {
    from: 'src/modules/executions/entry-points/http/operator/stream-run-events/endpoint.ts',
    to: 'src/modules/executions/application/ports/operator-sessions.ts',
  },
  {
    from: 'src/modules/executions/entry-points/http/operator/stream-run-events/endpoint.ts',
    to: 'src/modules/executions/application/ports/run-log-settings.ts',
  },
];

const APPLICATION_FILE = /^src\/modules\/[^/]+\/application\//;
const ENTRY_POINT_FILE = /^src\/modules\/[^/]+\/entry-points\//;
const INFRASTRUCTURE_FILE = /^src\/modules\/[^/]+\/infrastructure\//;
const REPOSITORY_OR_PORT_FILE =
  /^src\/modules\/[^/]+\/(domain\/repositories|application\/ports)\/[^/]+\.ts$/;
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
    ...contractsViolations(baseDir),
    ...directoryViolations(baseDir),
  ];
}

interface ModuleImport {
  /** The module specifier, e.g. `../ports/clock.js`. */
  specifier: string;
  /** Imported names; `*` for a namespace import, `default` for a default import. */
  names: string[];
}

/** Every `import … from` and `export … from` of a file (type-only ones included). */
function moduleImports(baseDir: string, path: string): ModuleImport[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(baseDir, path), 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const found: ModuleImport[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause
    ) {
      const { name, namedBindings } = statement.importClause;
      const names: string[] = [];
      if (name) names.push('default');
      if (namedBindings && ts.isNamespaceImport(namedBindings)) names.push('*');
      else if (namedBindings) {
        names.push(
          ...namedBindings.elements.map((element) => (element.propertyName ?? element.name).text),
        );
      }
      found.push({ specifier: statement.moduleSpecifier.text, names });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause;
      const names =
        clause && ts.isNamedExports(clause)
          ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
          : ['*'];
      found.push({ specifier: statement.moduleSpecifier.text, names });
    }
  }
  return found;
}

/** A relative specifier as a POSIX `.ts` path below the base directory (the file may not exist). */
function target(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  return `${joined.replace(/\.(js|ts)x?$/, '')}.ts`;
}

/**
 * `application/` imports no controller, route or parameter decorator of `@nestjs/common`
 * (rule 2: it knows nothing about HTTP). Its other HTTP, schema, OpenAPI, queue and
 * scheduler imports are the dependency rule `api-application-no-http-queue-scheduler-libraries`.
 */
function applicationDecoratorViolations(baseDir: string, path: string): Violation[] {
  return moduleImports(baseDir, path)
    .filter((entry) => entry.specifier === '@nestjs/common')
    .flatMap((entry) => entry.names.filter((name) => HTTP_DECORATORS.has(name)))
    .map((name) => ({
      rule: 'api-application-no-http-decorators',
      from: path,
      to: `@nestjs/common ${name}`,
    }));
}

/**
 * An entry point imports handlers, its own schemas and shared shapes, and domain errors and
 * types for mapping. It never imports anything from `infrastructure/`, and from a repository
 * interface or port file only error classes (names ending in `Error`).
 */
function entryPointViolations(baseDir: string, path: string): Violation[] {
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    if (!to) return [];
    if (INFRASTRUCTURE_FILE.test(to)) {
      return [{ rule: 'api-entry-points-no-ports-or-infrastructure', from: path, to }];
    }
    if (!REPOSITORY_OR_PORT_FILE.test(to)) return [];
    if (
      PINNED_ENTRY_POINT_PORT_IMPORTS.some((pinned) => pinned.from === path && pinned.to === to)
    ) {
      return [];
    }
    return entry.names
      .filter((name) => !ERROR_NAME.test(name))
      .map((name) => ({
        rule: 'api-entry-points-no-ports-or-infrastructure',
        from: path,
        to: `${to} ${name}`,
      }));
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
