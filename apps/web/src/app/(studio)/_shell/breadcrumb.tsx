'use client';

import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RunTitle } from '@/modules/executions';
import { ProjectName } from '@/modules/projects';
import { routeFor } from './routes';

const DETAIL_PATH = /^\/(projects|executions)\/([^/]+)(?:\/(preview))?\/?$/;

const CURRENT = 'block truncate px-1.5 py-1 font-medium text-text';

/**
 * The top-bar breadcrumb, derived from the route: `/projects` → Projects, `/projects/<id>` →
 * Projects › project name, `/executions/<id>` → Executions › the start of the Run's Task (each
 * from its module's cached query). Built here from tokens (prototype `.crumbs`).
 */
export function StudioBreadcrumb() {
  const pathname = usePathname();
  const route = routeFor(pathname);
  const detail = DETAIL_PATH.exec(pathname);
  const detailId = detail && route?.href === `/${detail[1]}` ? detail[2] : undefined;
  // `/projects/<id>/preview`: the project's name links back to the project.
  const previewPage = detail?.[3] === 'preview' && route?.href === '/projects';

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      {route ? (
        <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-label">
          {detailId ? (
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
              {previewPage ? (
                <>
                  <li className="min-w-0">
                    <Link
                      href={`${route.href}/${detailId}`}
                      className="block truncate rounded-sm px-1.5 py-1 text-text-muted no-underline hover:text-text pointer-coarse:py-3"
                    >
                      <ProjectName projectId={detailId} />
                    </Link>
                  </li>
                  <li aria-hidden="true" className="shrink-0 text-text-dim">
                    <ChevronRightIcon className="size-3.5" />
                  </li>
                  <li className="shrink-0">
                    <span aria-current="page" className={CURRENT}>
                      Preview
                    </span>
                  </li>
                </>
              ) : (
                <li className="min-w-0">
                  <span aria-current="page" className={CURRENT}>
                    {route.href === '/projects' ? (
                      <ProjectName projectId={detailId} />
                    ) : (
                      <RunTitle runId={detailId} />
                    )}
                  </span>
                </li>
              )}
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
