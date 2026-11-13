import { cookies } from 'next/headers';
import { OperatorMenu } from '../../platform/auth';
import { QueryProvider } from '../../platform/query/query-provider';
import { SidebarInset, SidebarProvider } from '@/shared/ui/sidebar';
import { parseSidebarOpen, SIDEBAR_COOKIE_NAME } from '@/shared/ui/sidebar-state';
import { StudioBreadcrumb } from './_shell/breadcrumb';
import { MobileNavButton } from './_shell/mobile-nav-button';
import { StudioSidebar } from './_shell/studio-sidebar';
import { ThemeMenuItem, ThemeToggle } from './_shell/theme-toggle';

const MAIN_ID = 'main-content';

/**
 * The Studio Shell (design-system Layout) around every Studio page: sidebar, sticky 56px top
 * bar (`topbar-height`) and the page capped at 1280px (`content-max`). A Server Component: it
 * reads the stored sidebar state from the request so the first paint matches; the sidebar,
 * theme toggle and operator menu are Client islands. The API enforces the session (401 →
 * login); the shell hides nothing that the API does not also protect.
 */
export default async function StudioLayout({ children }: LayoutProps<'/'>) {
  const sidebarOpen = parseSidebarOpen((await cookies()).get(SIDEBAR_COOKIE_NAME)?.value);

  return (
    <QueryProvider>
      <SidebarProvider defaultOpen={sidebarOpen}>
        <a
          href={`#${MAIN_ID}`}
          className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-label font-medium text-text shadow-float focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to main content
        </a>
        <StudioSidebar />
        <SidebarInset>
          <header
            aria-label="Top bar"
            className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-bg px-4 md:px-5"
          >
            <MobileNavButton />
            <StudioBreadcrumb />
            <ThemeToggle />
            <OperatorMenu>
              <ThemeMenuItem />
            </OperatorMenu>
          </header>
          <main
            id={MAIN_ID}
            tabIndex={-1}
            aria-label="Page content"
            className="flex-1 p-4 outline-none md:pt-7 md:pb-12 xl:px-8"
          >
            <div className="mx-auto w-full max-w-[1280px]">{children}</div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </QueryProvider>
  );
}
