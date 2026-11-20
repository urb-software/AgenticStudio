'use client';

import * as React from 'react';
import { cn } from '@/shared/lib/utils';
import { Tabs as TabsRoot, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
  /** The count is work waiting on the operator: it turns amber. */
  attention?: boolean;
}

type TabsProps = {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  label?: string;
  className?: string;
  children?: React.ReactNode;
};

function Tabs({ items, value, defaultValue, onChange, label, className, children }: TabsProps) {
  return (
    <TabsRoot
      value={value}
      defaultValue={defaultValue ?? (value === undefined ? items[0]?.value : undefined)}
      onValueChange={onChange}
      className={className}
    >
      <TabsList aria-label={label}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  'rounded-full px-1.5 text-caption font-medium tabular-nums',
                  item.attention
                    ? 'bg-run-awaiting-soft text-run-awaiting'
                    : 'bg-surface-raised text-text-muted',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </TabsRoot>
  );
}

/** The panel of one tab; `forceMount` keeps it mounted (hidden) while another tab is shown. */
function TabPanel({ className, ...props }: React.ComponentProps<typeof TabsContent>) {
  return <TabsContent className={cn('pt-4 data-[state=inactive]:hidden', className)} {...props} />;
}

export { TabPanel, Tabs, type TabsProps };
