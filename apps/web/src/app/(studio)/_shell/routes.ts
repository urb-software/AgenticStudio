import { Activity, Bot, Folder, type LucideIcon, Workflow } from 'lucide-react';

export type StudioRoute = { href: string; label: string; icon: LucideIcon };

/**
 * The Studio sections that exist, in the design system's order (design-system/components/
 * NavItem). Only built screens are listed: no links to routes that do not exist yet.
 */
export const STUDIO_ROUTES: readonly StudioRoute[] = [
  { href: '/projects', label: 'Projects', icon: Folder },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/executions', label: 'Executions', icon: Activity },
];

export function routeFor(pathname: string): StudioRoute | undefined {
  return STUDIO_ROUTES.find(
    (route) => pathname === route.href || pathname.startsWith(`${route.href}/`),
  );
}
