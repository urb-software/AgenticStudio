import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

// Same-origin /api/* proxy to the NestJS API, so the browser never needs CORS. The rules
// (dev always; production only with STUDIO_WEB_API_PROXY=true + API_ORIGIN) are canonical
// in README.md, "Web /api proxy"; next.config.test.ts pins them. The logic stays in this
// file because `next start` cannot load a separate TypeScript module from the config.

const DEFAULT_DEV_API_ORIGIN = 'http://localhost:3001';
const FLAG = 'STUDIO_WEB_API_PROXY';

/** The environment (e.g. `process.env`); only API_ORIGIN and STUDIO_WEB_API_PROXY are read. */
export type ApiProxyEnv = Readonly<Record<string, string | undefined>>;

export interface ApiProxy {
  /** Where /api/* is rewritten to; undefined means no rewrite. */
  readonly origin: string | undefined;
  /** A configuration that is valid but probably not what was intended. */
  readonly warning?: string;
}

function parseFlag(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${FLAG} must be "true" or "false" (or unset).`);
}

const INVALID_ORIGIN = 'API_ORIGIN must be an http(s) origin, e.g. http://localhost:3001.';

function parseOrigin(value: string): string {
  if (!URL.canParse(value)) {
    throw new Error(INVALID_ORIGIN);
  }
  const url = new URL(value);
  const isOrigin =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  if (!isOrigin) {
    throw new Error(INVALID_ORIGIN);
  }
  return url.origin;
}

export function resolveApiProxy(env: ApiProxyEnv, { devServer }: { devServer: boolean }): ApiProxy {
  const enabled = parseFlag(env.STUDIO_WEB_API_PROXY);
  const apiOrigin = env.API_ORIGIN ? parseOrigin(env.API_ORIGIN) : undefined;

  if (devServer) {
    return { origin: apiOrigin ?? DEFAULT_DEV_API_ORIGIN };
  }
  if (enabled) {
    if (!apiOrigin) {
      throw new Error(`${FLAG}=true requires API_ORIGIN (the API's origin).`);
    }
    return { origin: apiOrigin };
  }
  if (apiOrigin) {
    return {
      origin: undefined,
      warning: `API_ORIGIN is set but ${FLAG} is not "true": this build does not proxy /api.`,
    };
  }
  return { origin: undefined };
}

export default function nextConfig(phase: string): NextConfig {
  const config: NextConfig = {
    // Agent instructions are owned by the repository AGENTS.md; stop `next dev`
    // from generating an untracked apps/web/AGENTS.md.
    agentRules: false,
  };

  const proxy = resolveApiProxy(process.env, { devServer: phase === PHASE_DEVELOPMENT_SERVER });
  if (proxy.warning) {
    console.warn(`[next.config] ${proxy.warning}`);
  }
  const { origin } = proxy;
  if (!origin) {
    return config;
  }

  return {
    ...config,
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${origin}/api/:path*` }];
    },
  };
}
