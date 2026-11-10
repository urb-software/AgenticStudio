import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

// Local development only: proxy same-origin /api/* to the NestJS API so the
// browser never needs CORS. Deployment routing (Traefik) is out of scope here.
const DEFAULT_API_ORIGIN = 'http://localhost:3001';

export default function nextConfig(phase: string): NextConfig {
  const config: NextConfig = {
    // Agent instructions are owned by the repository AGENTS.md; stop `next dev`
    // from generating an untracked apps/web/AGENTS.md.
    agentRules: false,
  };

  if (phase !== PHASE_DEVELOPMENT_SERVER) {
    return config;
  }

  const apiOrigin = process.env.API_ORIGIN ?? DEFAULT_API_ORIGIN;

  return {
    ...config,
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
    },
  };
}
