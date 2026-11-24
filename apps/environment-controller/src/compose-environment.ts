/** The process environment of every Compose call: a fixed base plus the Environment file values. */
export interface ComposeBase {
  PATH: string;
  /** An empty directory, 0700. */
  HOME: string;
  /** An empty directory, 0700. */
  DOCKER_CONFIG: string;
  DOCKER_HOST: string;
  XDG_RUNTIME_DIR: string;
}

const STEERING_KEY = /^(COMPOSE_|DOCKER_|BUILDKIT_|BUILDX_|LD_)/;
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses a dotenv file: `KEY=value`, `export KEY=value`, quotes, `#` comments; no expansion. */
export function parseEnvironmentFile(content: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    pairs[match[1]!] = unquote(match[2]!);
  }
  return pairs;
}

function unquote(value: string): string {
  if (value.startsWith('"')) {
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
    let out = '';
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index]!;
      if (char === '"') break;
      if (char === '\\' && index + 1 < value.length) {
        index += 1;
        out += escapes[value[index]!] ?? value[index]!;
      } else {
        out += char;
      }
    }
    return out;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, '');
}

export interface ComposeEnvironment {
  env: Record<string, string>;
  /** Names of the Environment file keys that were not passed on. */
  dropped: string[];
}

export function composeEnvironment(
  base: ComposeBase,
  environmentFile: string | null,
): ComposeEnvironment {
  const env: Record<string, string> = { ...base };
  const dropped: string[] = [];
  const pairs = environmentFile === null ? {} : parseEnvironmentFile(environmentFile);
  for (const [key, value] of Object.entries(pairs)) {
    if (!VALID_KEY.test(key) || STEERING_KEY.test(key) || key in base) dropped.push(key);
    else env[key] = value;
  }
  return { env, dropped };
}
