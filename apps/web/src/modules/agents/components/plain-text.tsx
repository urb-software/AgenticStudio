import { cn } from '@/shared/lib/utils';

/**
 * Text from a definitions Repository (instructions, base rules) as plain text: it is a React text
 * child, so `<a>` and `<script>` in it stay visible characters, never markup, and no link in it
 * is followed. Line breaks are kept (`white-space: pre-wrap`); long lines wrap.
 */
export function PlainText({
  text,
  className,
  ...props
}: { text: string } & Omit<React.ComponentProps<'div'>, 'children'>) {
  return (
    <div
      data-slot="plain-text"
      className={cn(
        'max-h-96 overflow-auto rounded-md border border-border bg-bg-subtle p-3 font-mono text-code break-words whitespace-pre-wrap',
        className,
      )}
      // A scrollable region must be reachable by keyboard.
      tabIndex={0}
      {...props}
    >
      {text}
    </div>
  );
}
