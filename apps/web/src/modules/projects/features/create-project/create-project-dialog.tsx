'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type Resolver, useForm } from 'react-hook-form';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { toast } from '@/shared/ui/sonner';
import {
  ApiError,
  type CreateProjectRequest,
  createProjectRequestHint,
} from '../../../../platform/api';
import { useCreateProject } from '../../api/projects-queries';
import { normalizeForHint } from './normalize-for-hint';

/** Plain messages for the client-side checks; the generated schema has zod's defaults. */
function hintMessage(issue: { code?: string; maximum?: unknown }): string | undefined {
  if (issue.code === 'too_small') return 'Enter a project name.';
  if (issue.code === 'too_big') return `Use at most ${String(issue.maximum)} characters.`;
  return undefined;
}

const checkHint = zodResolver(createProjectRequestHint, { error: hintMessage });

/** Checks the hint against the normalized name, because the API measures it after normalizing. */
const resolver: Resolver<CreateProjectRequest> = (values, context, options) =>
  checkHint({ name: normalizeForHint(values.name) }, context, options);

/** Server field errors (400/409 `errors[]`) that this form can show next to a field. */
function nameErrorOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  return error.problem?.errors?.find((fieldError) => fieldError.path === 'name')?.message;
}

/** A failure without a field error: the problem+json title in bold, then the detail. */
function ServerError({ error }: { error: unknown }) {
  const problem = error instanceof ApiError ? error.problem : undefined;
  return problem ? (
    <Banner tone="danger" title={problem.title}>
      {problem.detail}
    </Banner>
  ) : (
    <Banner tone="danger">Could not create the project. Try again.</Banner>
  );
}

type CreateProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The New project dialog (a bottom sheet on phones). The generated Zod schema gives quick
 * client-side feedback; the API is authoritative (normalization, duplicates), and its field
 * errors land on the field. On success it closes and a toast confirms; on failure it stays
 * open with the error. It cannot be closed while the request is in flight.
 */
export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const createProject = useCreateProject();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectRequest>({
    resolver,
    defaultValues: { name: '' },
  });

  function close() {
    reset();
    createProject.reset();
    onOpenChange(false);
  }

  function changeOpen(next: boolean) {
    if (next) onOpenChange(true);
    else if (!isSubmitting) close();
  }

  async function onSubmit(values: CreateProjectRequest) {
    try {
      await createProject.mutateAsync(values);
    } catch (cause) {
      const nameError = nameErrorOf(cause);
      if (nameError) {
        setError('name', { type: 'server', message: nameError }, { shouldFocus: true });
      }
      return;
    }
    close();
    toast.success('Project created');
  }

  // Shown as a banner only when it is not a field error (those sit on the field).
  const serverError =
    createProject.error && !nameErrorOf(createProject.error) ? createProject.error : null;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {serverError ? <ServerError error={serverError} /> : null}
            <TextField
              id="project-name"
              label="Project name"
              type="text"
              autoComplete="off"
              error={errors.name?.message}
              // Read-only, not disabled, while creating: a server field error can still focus it.
              readOnly={isSubmitting}
              {...register('name')}
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
