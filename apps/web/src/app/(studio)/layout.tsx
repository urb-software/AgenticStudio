import { QueryProvider } from '../../platform/query/query-provider';

/** Studio pages: API state through TanStack Query. The API enforces the session (401 → login). */
export default function StudioLayout({ children }: LayoutProps<'/'>) {
  return <QueryProvider>{children}</QueryProvider>;
}
