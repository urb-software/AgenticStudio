'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PlayIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useRef } from 'react';
import { Controller, type Resolver, useForm } from 'react-hook-form';
import { Banner } from '@/shared/components/banner';
import { SegmentedControl } from '@/shared/components/segmented-control';
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
import { useStartRun } from '../../api/runs-queries';
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
};

/**
 * The New run dialog (a bottom sheet on phones): the Task as free text and the Provider, Claude
 * Code preselected. The generated Zod schema gives quick feedback; the API is authoritative,
 * and its field errors land on the field, any other rejection (no ready Repository) shows the
 * server's title and detail. On success it opens the new Run's page. It cannot be closed while
 * the request is in flight.
 */
export function NewRunDialog({ projectId, open, onOpenChange }: NewRunDialogProps) {
  const router = useRouter();
  const id = useId();
  const PROVIDER_LABEL_ID = `${id}-provider-label`;
  const PROVIDER_ERROR_ID = `${id}-provider-error`;
  const startRun = useStartRun(projectId);
  const {
    control,
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<StartRunRequest>({
    resolver,
    defaultValues: { task: '', provider: 'claude_code' },
  });

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
                    options={PROVIDER_OPTIONS}
                    value={field.value}
                    disabled={submitting}
                    onChange={field.onChange}
                  />
                )}
              />
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
            <Button type="submit" variant="primary" icon={PlayIcon} loading={submitting}>
              {submitting ? 'Starting…' : 'Start run'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
