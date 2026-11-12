'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type Resolver, useForm } from 'react-hook-form';
import {
  ApiError,
  type CreateProjectRequest,
  createProjectRequestHint,
} from '../../../../platform/api';
import { useCreateProject } from '../../api/projects-queries';

const NAME_ERROR_ID = 'project-name-error';

/** Plain messages for the client-side checks; the generated schema has zod's defaults. */
function hintMessage(issue: { code?: string; maximum?: unknown }): string | undefined {
  if (issue.code === 'too_small') return 'Enter a project name.';
  if (issue.code === 'too_big') return `Use at most ${String(issue.maximum)} characters.`;
  return undefined;
}

const checkHint = zodResolver(createProjectRequestHint, { error: hintMessage });

/**
 * Checks the hint against the name with whitespace runs collapsed, because the API measures
 * the length after normalizing (trim + collapse); the API stays the authority.
 */
const resolver: Resolver<CreateProjectRequest> = (values, context, options) =>
  checkHint({ name: values.name.trim().replace(/\s+/gu, ' ') }, context, options);

/** Server field errors (400/409 `errors[]`) that this form can show next to a field. */
function nameErrorOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  return error.problem?.errors?.find((fieldError) => fieldError.path === 'name')?.message;
}

/**
 * Creates a project. The generated Zod schema gives quick client-side feedback; the API
 * is authoritative (normalization, duplicates), and its field errors land on the field.
 */
export function CreateProjectForm() {
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

  async function onSubmit(values: CreateProjectRequest) {
    try {
      await createProject.mutateAsync(values);
      reset();
    } catch (cause) {
      const nameError = nameErrorOf(cause);
      if (nameError) {
        setError('name', { type: 'server', message: nameError }, { shouldFocus: true });
      } else {
        setError('root', { type: 'server', message: 'Could not create the project. Try again.' });
      }
    }
  }

  const nameError = errors.name?.message;
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <label htmlFor="project-name">Project name</label>
      <input
        id="project-name"
        type="text"
        autoComplete="off"
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? NAME_ERROR_ID : undefined}
        {...register('name')}
      />
      {nameError ? <p id={NAME_ERROR_ID}>{nameError}</p> : null}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating…' : 'Create project'}
      </button>
      {errors.root?.message ? <p role="alert">{errors.root.message}</p> : null}
    </form>
  );
}
