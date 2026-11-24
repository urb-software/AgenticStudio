import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function segment(value: string): string {
  if (!UUID.test(value)) throw new Error('A path segment must be a UUID.');
  return value;
}

/** Where one build lives; every path is below the Project's own 0700 directory. */
export interface BuildLayout {
  /** `previews/<projectId>`. */
  previewRoot: string;
  buildDir: string;
  /** The unpacked source, the Compose project directory. */
  srcDir: string;
  stackFile: string;
  overrideFile: string;
  emptyEnvFile: string;
  /** The empty HOME and DOCKER_CONFIG of the Compose process, 0700. */
  homeDir: string;
  dockerConfigDir: string;
}

export function previewRoot(dataDir: string, projectId: string): string {
  return join(dataDir, 'previews', segment(projectId));
}

export function buildLayout(dataDir: string, projectId: string, operationId: string): BuildLayout {
  const root = previewRoot(dataDir, projectId);
  const buildDir = join(root, 'builds', segment(operationId));
  return {
    previewRoot: root,
    buildDir,
    srcDir: join(buildDir, 'src'),
    stackFile: join(buildDir, 'compose.stack.yaml'),
    overrideFile: join(buildDir, 'compose.controller.yaml'),
    emptyEnvFile: join(buildDir, 'empty.env'),
    homeDir: join(buildDir, 'home'),
    dockerConfigDir: join(buildDir, 'docker-config'),
  };
}

export const buildsDir = (dataDir: string, projectId: string) =>
  join(previewRoot(dataDir, projectId), 'builds');
export const desiredStateFile = (dataDir: string, projectId: string) =>
  join(previewRoot(dataDir, projectId), 'desired.json');
