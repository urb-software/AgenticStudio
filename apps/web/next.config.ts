import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

// Same-origin /api/* is proxied to the NestJS API, so the browser never needs CORS:
// - `next dev` always proxies, to API_ORIGIN or the default below;
// - a production build proxies only when API_ORIGIN is set at build time (the rewrite is
//   baked into the build), as the e2e smoke run does.
// Deployment routing (Traefik) is out of scope here.
const DEFAULT_API_ORIGIN = 'http://localhost:3001';

export default function nextConfig(phase: string): NextConfig {
  const config: NextConfig = {
    // Agent instructions are owned by the repository AGENTS.md; stop `next dev`
    // from generating an untracked apps/web/AGENTS.md.
    agentRules: false,
  };

  const apiOrigin =
    process.env.API_ORIGIN ?? (phase === PHASE_DEVELOPMENT_SERVER ? DEFAULT_API_ORIGIN : undefined);
  if (!apiOrigin) {
    return config;
  }

  return {
    ...config,
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
    },
  };
}
