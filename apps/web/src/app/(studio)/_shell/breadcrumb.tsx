'use client';

import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ProjectName } from '@/modules/projects';
import { routeFor } from './routes';

/** `/projects/<id>`: the project screen, one level below Projects. */
const PROJECT_PATH = /^\/projects\/([^/]+)\/?$/;

const CURRENT = 'block truncate px-1.5 py-1 font-medium text-text';

/**
 * The top-bar breadcrumb, derived from the route: `/projects` → Projects, `/projects/<id>` →
 * Projects › project name (the name from the projects module's cached query). Built here from
 * tokens (prototype `.crumbs`).
 */
export function StudioBreadcrumb() {
  const pathname = usePathname();
  const route = routeFor(pathname);
  const projectId = route?.href === '/projects' ? PROJECT_PATH.exec(pathname)?.[1] : undefined;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      {route ? (
        <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-label">
          {projectId ? (
            <>
              <li className="shrink-0">
                <Link
                  href={route.href}
                  className="block rounded-sm px-1.5 py-1 text-text-muted no-underline hover:text-text pointer-coarse:py-3"
                >
                  {route.label}
                </Link>
              </li>
              <li aria-hidden="true" className="shrink-0 text-text-dim">
                <ChevronRightIcon className="size-3.5" />
              </li>
              <li className="min-w-0">
                <span aria-current="page" className={CURRENT}>
                  <ProjectName projectId={projectId} />
                </span>
              </li>
            </>
          ) : (
            <li className="min-w-0">
              <span aria-current="page" className={CURRENT}>
                {route.label}
              </span>
            </li>
          )}
        </ol>
      ) : null}
    </nav>
  );
}
