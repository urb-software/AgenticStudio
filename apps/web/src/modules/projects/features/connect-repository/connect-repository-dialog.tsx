'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type FormEvent, useRef } from 'react';
import { type Resolver, useForm } from 'react-hook-form';
import { Banner } from '@/shared/components/banner';
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
import {
  ApiError,
  type ConnectRepositoryRequest,
  connectRepositoryRequestHint,
} from '../../../../platform/api';
import { useConnectRepository } from '../../api/projects-queries';

/** The Integration branch a new connection is prefilled with (Epic #55). */
const DEFAULT_INTEGRATION_BRANCH = 'dev';

type Field = keyof ConnectRepositoryRequest;
const FIELDS: readonly Field[] = ['url', 'integrationBranch'];

/** Plain messages for the client-side checks; the generated schema has zod's defaults. */
function hintMessage(issue: {
  code?: string;
  maximum?: unknown;
  path?: PropertyKey[];
}): string | undefined {
  const field = issue.path?.[0];
  if (issue.code === 'too_small') {
    return field === 'url' ? 'Enter the repository URL.' : 'Enter the integration branch.';
  }
  if (issue.code === 'too_big') return `Use at most ${String(issue.maximum)} characters.`;
  if (issue.code === 'invalid_format') return 'Enter a valid branch name, e.g. dev.';
  return undefined;
}

const checkHint = zodResolver(connectRepositoryRequestHint, { error: hintMessage });

/** The API trims both fields before its checks; the hint checks the trimmed values too. */
const resolver: Resolver<ConnectRepositoryRequest> = (values, context, options) =>
  checkHint(
    { url: values.url.trim(), integrationBranch: values.integrationBranch.trim() },
    context,
    options,
  );

/** Server field errors (422, or 409 for a remote held by another project) by field. */
function fieldErrorsOf(error: unknown): Partial<Record<Field, string>> {
  if (!(error instanceof ApiError)) return {};
  const errors: Partial<Record<Field, string>> = {};
  for (const fieldError of error.problem?.errors ?? []) {
    const field = FIELDS.find((name) => name === fieldError.path);
    if (field && !errors[field]) errors[field] = fieldError.message;
  }
  return errors;
}

type ConnectRepositoryDialogProps = {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The Connect repository dialog (a bottom sheet on phones): "Repository URL" and
 * "Integration branch" (prefilled `dev`). The generated schema gives quick hints; the API is
 * authoritative, and its field errors land on the fields. Any other failure (another
 * repository already connected, an unsupported platform) shows as a banner with the
 * problem's title and detail. On success it closes; the card then shows the clone's progress.
 */
export function ConnectRepositoryDialog({
  projectId,
  open,
  onOpenChange,
}: ConnectRepositoryDialogProps) {
  const connect = useConnectRepository(projectId);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ConnectRepositoryRequest>({
    resolver,
    defaultValues: { url: '', integrationBranch: DEFAULT_INTEGRATION_BRANCH },
  });

  const submitting = isSubmitting || connect.isPending;
  const inFlight = useRef(false);

  function close() {
    reset();
    connect.reset();
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
    void handleSubmit(onSubmit, () => {
      inFlight.current = false;
    })(event);
  }

  async function onSubmit(values: ConnectRepositoryRequest) {
    try {
      await connect.mutateAsync({
        url: values.url.trim(),
        integrationBranch: values.integrationBranch.trim(),
      });
    } catch (cause) {
      inFlight.current = false;
      const fieldErrors = fieldErrorsOf(cause);
      FIELDS.forEach((field, index) => {
        const message = fieldErrors[field];
        if (message) {
          setError(
            field,
            { type: 'server', message },
            { shouldFocus: index === 0 || !fieldErrors.url },
          );
        }
      });
      return;
    }
    inFlight.current = false;
    close();
  }

  const serverError =
    connect.error && Object.keys(fieldErrorsOf(connect.error)).length === 0 ? connect.error : null;
  const problem = serverError instanceof ApiError ? serverError.problem : undefined;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Connect repository</DialogTitle>
            <DialogDescription>
              A public repository over HTTPS. Studio clones it; agents later branch from the
              integration branch.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {serverError ? (
              <Banner tone="danger" title={problem?.title}>
                {problem?.detail || 'Could not connect the repository. Try again.'}
              </Banner>
            ) : null}
            <TextField
              id="repository-url"
              label="Repository URL"
              type="url"
              inputMode="url"
              mono
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://github.com/owner/repo.git"
              error={errors.url?.message}
              readOnly={submitting}
              {...register('url')}
            />
            <TextField
              id="integration-branch"
              label="Integration branch"
              type="text"
              mono
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              help="Agents start from this branch, and approved work merges into it."
              error={errors.integrationBranch?.message}
              readOnly={submitting}
              {...register('integrationBranch')}
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={submitting}>
              {submitting ? 'Connecting…' : 'Connect repository'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
