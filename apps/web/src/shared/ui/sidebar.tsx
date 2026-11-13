'use client';

import * as React from 'react';
import { cn } from '@/shared/lib/utils';

import { XIcon } from 'lucide-react';
import { useHydrated } from '@/shared/hooks/use-hydrated';
import { useIsMobile, useIsTablet } from '@/shared/hooks/use-viewport';
import { Button } from '@/shared/ui/button';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
import { SIDEBAR_COOKIE_MAX_AGE, SIDEBAR_COOKIE_NAME } from '@/shared/ui/sidebar-state';

// Trimmed from the shadcn Sidebar to what the Studio Shell uses (#43): a left sidebar that
// collapses to an icon rail on tablet and desktop and is an off-canvas sheet on phones. The
// generated floating/inset variants, right side, rail, sub-menus, menu buttons/actions/badges/
// skeletons, search input, Cmd/Ctrl+B shortcut and trigger were removed; nothing used them.
// Widths (design-system Layout: 240px sidebar, 64px icon rail) are CSS variables set in
// classNames, not style= props: --sidebar-width, --sidebar-width-icon.

type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  /** No stored choice and the width not yet known (server render, hydration): CSS decides. */
  auto: boolean;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}

/**
 * `defaultOpen` is the operator's stored choice (the `sidebar_state` cookie, read on the
 * server so the first paint matches). Without one, the sidebar starts expanded on desktop and
 * collapsed to the icon rail on tablet (frontend.md §9); that default is never stored. The
 * server cannot know the width, so until the client does, the markup carries `data-auto` and
 * `group-data-[auto=true]:md:max-xl:` styles draw the tablet rail (consumers read `auto` to do
 * the same for their own content): no flash either way.
 */
function SidebarProvider({
  defaultOpen,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { defaultOpen?: boolean }) {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [choice, setChoice] = React.useState<boolean | undefined>(defaultOpen);
  const hydrated = useHydrated();
  const open = choice ?? !isTablet;
  const auto = choice === undefined && !hydrated;

  const setOpen = React.useCallback((value: boolean) => {
    setChoice(value);
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${value}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`;
  }, []);

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile((value) => !value);
    } else {
      setOpen(!open);
    }
  }, [isMobile, open, setOpen]);

  // `state` sets data-collapsible="icon" on the sidebar, which drives the
  // group-data-[collapsible=icon] styles.
  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, auto, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, auto, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        className={cn(
          'flex min-h-svh w-full [--sidebar-width-icon:4rem] [--sidebar-width:15rem]',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/** The navigation column: an icon-collapsible column from 768px, a left sheet below. */
function Sidebar({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { isMobile, state, auto, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          data-slot="sidebar"
          data-mobile="true"
          aria-describedby={undefined}
          showCloseButton={false}
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [--sidebar-width:18rem]"
          side="left"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
          {/* Visible and reachable by touch screen readers too (no Esc key, overlay unreachable). */}
          <SheetClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close navigation"
              className="absolute top-3.5 right-3 text-text-muted hover:text-text"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </SheetClose>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? 'icon' : ''}
      data-auto={auto ? 'true' : undefined}
      data-slot="sidebar"
    >
      {/* Reserves the sidebar's width in the page flow; the container itself is fixed. */}
      <div
        data-slot="sidebar-gap"
        className="relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-(--sidebar-width-icon) motion-reduce:transition-none group-data-[auto=true]:md:max-xl:w-(--sidebar-width-icon)"
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 left-0 z-10 hidden h-svh w-(--sidebar-width) border-r border-sidebar-border transition-[width] duration-200 ease-linear group-data-[collapsible=icon]:w-(--sidebar-width-icon) motion-reduce:transition-none md:flex group-data-[auto=true]:md:max-xl:w-(--sidebar-width-icon)',
          className,
        )}
        {...props}
      >
        <div data-slot="sidebar-inner" className="flex size-full flex-col bg-sidebar">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The column beside the sidebar: holds the top bar and the page's `main`. */
function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn('relative flex w-full min-w-0 flex-1 flex-col bg-background', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="sidebar-menu-item" className={cn('relative', className)} {...props} />;
}

export {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
};
