import * as React from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';

type TextFieldOwnProps = {
  /** Visible label, mandatory: no placeholder-as-label. */
  label: string;
  /** Help text under the control, wired with aria-describedby. */
  help?: string;
  /** Replaces the help text and marks the control invalid. Say what's wrong and how to fix it. */
  error?: string;
  /** For code values: repo URLs, branch names, commands, env var names. */
  mono?: boolean;
  className?: string;
};

type TextFieldProps = TextFieldOwnProps &
  (
    | ({ multiline?: false } & Omit<React.ComponentProps<'input'>, keyof TextFieldOwnProps>)
    | ({ multiline: true } & Omit<React.ComponentProps<'textarea'>, keyof TextFieldOwnProps>)
  );

/**
 * Labelled input (design-system/components/TextField): label + input (or textarea when
 * `multiline`) + help or error text, wired with htmlFor and aria-describedby.
 */
function TextField({ label, help, error, mono = false, className, ...control }: TextFieldProps) {
  const generatedId = React.useId();
  const id = control.id ?? generatedId;
  const messageId = `${id}-message`;
  const message = error ?? help;
  const describedBy =
    [control['aria-describedby'], message ? messageId : undefined].filter(Boolean).join(' ') ||
    undefined;
  const wiring = {
    id,
    'aria-invalid': error ? true : control['aria-invalid'],
    'aria-describedby': describedBy,
    // Mono text is 13px from tablet up; phones keep 16px so focus does not zoom.
    className: cn(mono && 'font-mono md:text-[13px]'),
  };

  return (
    <div data-slot="text-field" className={cn('flex min-w-0 flex-col', className)}>
      <Label htmlFor={id} className="mb-1.5">
        {label}
      </Label>
      {control.multiline ? (
        <Textarea {...withoutMultiline(control)} {...wiring} />
      ) : (
        <Input {...withoutMultiline(control)} {...wiring} />
      )}
      {error ? (
        <p
          id={messageId}
          role="alert"
          className="mt-1.5 mb-0 flex items-center gap-1.5 text-[12.5px] text-run-failed"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : help ? (
        <p id={messageId} className="mt-1.5 mb-0 text-[12.5px] text-text-dim">
          {help}
        </p>
      ) : null}
    </div>
  );
}

function withoutMultiline<T extends { multiline?: boolean }>(props: T): Omit<T, 'multiline'> {
  const rest = { ...props };
  delete rest.multiline;
  return rest;
}

export { TextField, type TextFieldProps };
