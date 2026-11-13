'use client';

import { PanelLeft } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { IconButton } from '@/shared/components/icon-button';
import { NavItem } from '@/shared/components/nav-item';
import { cn } from '@/shared/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/shared/ui/sidebar';
import { LogoMark } from './logo-mark';
import { routeFor, STUDIO_ROUTES } from './routes';

/**
 * The Studio Shell sidebar: logo tile, the collapse toggle and the section links. A 240px
 * column that collapses to the 64px icon rail; on phones the same content in a sheet.
 */
export function StudioSidebar() {
  const pathname = usePathname();
  const { state, isMobile, toggleSidebar, setOpenMobile } = useSidebar();
  const collapsed = !isMobile && state === 'collapsed';
  const active = routeFor(pathname);

  return (
    <Sidebar>
      {/* The whole column is the landmark, so the logo and toggle are inside one too. */}
      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader
          className={cn(
            'flex-row items-center gap-2.5 px-3.5 pt-3.5 pb-2',
            collapsed && 'flex-col gap-2 px-2.5',
          )}
        >
          <LogoMark />
          {collapsed ? null : (
            <span className="flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-text">
              Agent Studio
            </span>
          )}
          {isMobile ? null : (
            <IconButton
              icon={PanelLeft}
              size="sm"
              label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
            />
          )}
        </SidebarHeader>
        <SidebarContent className="px-2.5 py-1">
          <SidebarMenu>
            {STUDIO_ROUTES.map((route) => (
              <SidebarMenuItem key={route.href}>
                <NavItem
                  href={route.href}
                  icon={route.icon}
                  label={route.label}
                  active={active?.href === route.href}
                  collapsed={collapsed}
                  onClick={() => setOpenMobile(false)}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>
      </nav>
    </Sidebar>
  );
}
