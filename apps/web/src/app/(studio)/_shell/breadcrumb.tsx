'use client';

import { usePathname } from 'next/navigation';
import { routeFor } from './routes';

/**
 * The top-bar breadcrumb, derived from the route (`/projects` → Projects). Built here from
 * tokens (prototype `.crumbs`); deeper levels arrive with the screens that need them.
 */
export function StudioBreadcrumb() {
  const route = routeFor(usePathname());

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      {route ? (
        <ol className="flex items-center gap-1.5 text-label">
          <li className="min-w-0">
            <span aria-current="page" className="block truncate px-1.5 py-1 font-medium text-text">
              {route.label}
            </span>
          </li>
        </ol>
      ) : null}
    </nav>
  );
}
