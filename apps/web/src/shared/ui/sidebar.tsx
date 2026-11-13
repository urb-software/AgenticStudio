'use client';

import * as React from 'react';
import { cn } from '@/shared/lib/utils';

import { useIsMobile, useIsTablet } from '@/shared/hooks/use-mobile';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
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
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const noSubscription = () => () => {};

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
 * `group-data-[auto=true]:md:max-xl:` styles draw the tablet rail: no flash either way.
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
  const hydrated = React.useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
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

  // data-state="expanded" | "collapsed" drives the group-data-[collapsible=icon] styles.
  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, auto, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, auto, open, setOpen, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full [--sidebar-width-icon:4rem] [--sidebar-width:15rem]',
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
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          aria-describedby={undefined}
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [--sidebar-width:18rem] [&>button]:hidden"
          side="left"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
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
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex size-full flex-col bg-sidebar"
        >
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
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
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
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
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
