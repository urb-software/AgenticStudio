'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PlayIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Controller, type Resolver, useForm } from 'react-hook-form';
import { Banner } from '@/shared/components/banner';
import { SegmentedControl, type SegmentedOption } from '@/shared/components/segmented-control';
import { TextField } from '@/shared/components/text-field';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { ApiError, type StartRunRequest, startRunRequestHint } from '../../../../platform/api';
import { useProviderAvailability, useStartRun } from '../../api/runs-queries';
import { PROVIDER_OPTIONS } from '../../components/run-presentation';

/** Plain messages for the client-side checks; the generated schema has zod's defaults. */
function hintMessage(issue: { code?: string; maximum?: unknown }): string | undefined {
  if (issue.code === 'too_small') return 'Enter a task.';
  if (issue.code === 'too_big') return `Use at most ${String(issue.maximum)} characters.`;
  return undefined;
}

const checkHint = zodResolver(startRunRequestHint, { error: hintMessage });

/**
 * Checks the hint against the trimmed Task, because the API trims it before measuring (its
 * start-run schema); the value sent is the operator's text, and the API's answer is final.
 */
const resolver: Resolver<StartRunRequest> = (values, context, options) =>
  checkHint({ ...values, task: values.task.trim() }, context, options);

type Field = keyof StartRunRequest;
const FIELDS: readonly Field[] = ['task', 'provider'];

/** Server field errors (422 `errors[]`) that this form can show next to a field. */
function fieldErrorsOf(error: unknown): [Field, string][] {
  if (!(error instanceof ApiError)) return [];
  return (error.problem?.errors ?? []).flatMap((fieldError) =>
    FIELDS.includes(fieldError.path as Field)
      ? [[fieldError.path as Field, fieldError.message] as [Field, string]]
      : [],
  );
}

type NewRunDialogProps = {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill ("Run again": the same Task and Provider); the defaults are empty and Claude Code. */
  initialValues?: StartRunRequest;
};

const EMPTY: StartRunRequest = { task: '', provider: 'claude_code' };

type Provider = NonNullable<StartRunRequest['provider']>;

/**
 * The first available provider is preselected (Claude Code when available) unless the prefilled
 * one is available; when none is, the dialog cannot start a Run.
 * If availability cannot be read, both are offered and the server decides.
 */
export function NewRunDialog({
  projectId,
  open,
  onOpenChange,
  initialValues = EMPTY,
}: NewRunDialogProps) {
  const router = useRouter();
  const id = useId();
  const PROVIDER_LABEL_ID = `${id}-provider-label`;
  const PROVIDER_ERROR_ID = `${id}-provider-error`;
  const PROVIDER_CHECKING_ID = `${id}-provider-checking`;
  const startRun = useStartRun(projectId);
  // Counts openings, updated while rendering so the first render of an opening already uses a
  // fresh availability entry (and never an earlier opening's answer).
  const [wasOpen, setWasOpen] = useState(open);
  const [opening, setOpening] = useState(open ? 1 : 0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpening((count) => count + 1);
  }
  const availability = useProviderAvailability(opening, open);
  const checking = availability.isPending && !availability.isError;
  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<StartRunRequest>({
    resolver,
    defaultValues: initialValues,
  });

  // Why each unavailable provider is unavailable; empty until the availability is read.
  const unavailable = useMemo(
    () =>
      new Map<Provider, string>(
        (availability.data ?? []).flatMap((provider) =>
          provider.available ? [] : [[provider.id, provider.reason ?? 'Unavailable'] as const],
        ),
      ),
    [availability.data],
  );
  const noneAvailable = unavailable.size === PROVIDER_OPTIONS.length;
  const providerOptions: SegmentedOption<Provider>[] = PROVIDER_OPTIONS.map((option) =>
    checking
      ? { ...option, disabled: true, describedBy: PROVIDER_CHECKING_ID }
      : unavailable.has(option.value)
        ? { ...option, disabled: true, describedBy: `${id}-unavailable-${option.value}` }
        : option,
  );

  // On every opening, once its availability answer is in, move off an unavailable provider
  // (the default or a Run again prefill) to the first available one.
  useEffect(() => {
    if (!open || !availability.data || !unavailable.has(getValues('provider') ?? 'claude_code'))
      return;
    const first = PROVIDER_OPTIONS.find((option) => !unavailable.has(option.value));
    if (first) setValue('provider', first.value);
  }, [open, opening, availability.data, unavailable, getValues, setValue]);

  const submitting = isSubmitting || startRun.isPending;
  // The disabled button stops clicks; this stops a second submit by other means (Enter, script).
  const inFlight = useRef(false);

  function close() {
    reset();
    startRun.reset();
    onOpenChange(false);
  }

  function changeOpen(next: boolean) {
    if (next) onOpenChange(true);
    else if (!submitting) close();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    if (inFlight.current) {
      event.preventDefault();
      return;
    }
    inFlight.current = true;
    const invalid = () => {
      inFlight.current = false;
    };
    void handleSubmit(onSubmit, invalid)(event);
  }

  async function onSubmit(values: StartRunRequest) {
    let runId: string;
    try {
      runId = (await startRun.mutateAsync(values)).id;
    } catch (cause) {
      inFlight.current = false;
      fieldErrorsOf(cause).forEach(([field, message], index) =>
        setError(field, { type: 'server', message }, { shouldFocus: index === 0 }),
      );
      return;
    }
    inFlight.current = false;
    close();
    router.push(`/executions/${runId}`);
  }

  // Shown as a banner only when it is not a field error (those sit on the field).
  const serverError =
    startRun.error && fieldErrorsOf(startRun.error).length === 0 ? startRun.error : null;
  const problem = serverError instanceof ApiError ? serverError.problem : undefined;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="md:max-w-[560px]">
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>New run</DialogTitle>
            <DialogDescription>
              An agent carries out the task in its own working copy, never on the integration
              branch.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {serverError ? (
              <Banner tone="danger" title={problem?.title}>
                {problem?.detail || 'Could not start the run. Try again.'}
              </Banner>
            ) : null}
            <TextField
              label="Task"
              multiline
              rows={5}
              placeholder="Add pagination to the products API"
              error={errors.task?.message}
              readOnly={submitting}
              {...register('task')}
            />
            <div className="flex flex-col">
              <Label id={PROVIDER_LABEL_ID} className="mb-1.5">
                Provider
              </Label>
              <Controller
                control={control}
                name="provider"
                render={({ field }) => (
                  <SegmentedControl
                    aria-labelledby={PROVIDER_LABEL_ID}
                    aria-describedby={errors.provider ? PROVIDER_ERROR_ID : undefined}
                    options={providerOptions}
                    value={field.value}
                    disabled={submitting}
                    onChange={field.onChange}
                  />
                )}
              />
              {checking ? (
                <p
                  id={PROVIDER_CHECKING_ID}
                  role="status"
                  className="mt-1.5 mb-0 text-code text-text-muted"
                >
                  Checking which providers are available…
                </p>
              ) : null}
              {providerOptions.flatMap((option) =>
                option.describedBy && !checking ? (
                  <p
                    key={option.value}
                    id={option.describedBy}
                    className="mt-1.5 mb-0 text-code text-text-muted"
                  >
                    {option.label}: {unavailable.get(option.value)}
                  </p>
                ) : (
                  []
                ),
              )}
              {availability.isError ? (
                <p className="mt-1.5 mb-0 text-code text-text-muted">
                  Couldn&apos;t check which providers are available.
                </p>
              ) : null}
              {errors.provider?.message ? (
                <p
                  id={PROVIDER_ERROR_ID}
                  role="alert"
                  className="mt-1.5 mb-0 flex items-center gap-1.5 text-code text-run-failed"
                >
                  <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  {errors.provider.message}
                </p>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              icon={PlayIcon}
              loading={submitting}
              disabled={checking || noneAvailable}
            >
              {submitting ? 'Starting…' : 'Start run'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
