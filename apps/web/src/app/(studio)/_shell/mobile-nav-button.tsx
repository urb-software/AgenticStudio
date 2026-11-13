'use client';

import { Menu } from 'lucide-react';
import { IconButton } from '@/shared/components/icon-button';
import { useSidebar } from '@/shared/ui/sidebar';

/** Phones only: opens the navigation sheet from the top bar. */
export function MobileNavButton() {
  const { openMobile, setOpenMobile } = useSidebar();

  return (
    <IconButton
      icon={Menu}
      label="Open navigation"
      aria-haspopup="dialog"
      aria-expanded={openMobile}
      className="-ml-1.5 md:hidden"
      onClick={() => setOpenMobile(true)}
    />
  );
}
