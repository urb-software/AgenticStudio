'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
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
import { ApiError } from '../../../../platform/api';
import { useSetEnvironmentFile } from '../../api/projects-queries';

/** The path a new Environment file is prefilled with (Issue #104). */
export const DEFAULT_ENVIRONMENT_FILE_PATH = '.env';

/** Largest content, in UTF-8 bytes (the API's limit, 64 KiB). */
const MAX_BYTES = 64 * 1024;

type Field = 'path' | 'content';

/** The API's field errors (422) by field. */
function fieldErrorsOf(error: unknown): Partial<Record<Field, string>> {
  if (!(error instanceof ApiError)) return {};
  const errors: Partial<Record<Field, string>> = {};
  for (const fieldError of error.problem?.errors ?? []) {
    if ((fieldError.path === 'path' || fieldError.path === 'content') && !errors[fieldError.path]) {
      errors[fieldError.path] = fieldError.message;
    }
  }
  return errors;
}

type EnvironmentFileDialogProps = {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The path of the file being replaced; a new file starts with `.env`. */
  currentPath?: string;
  /** Called after a save; the card confirms it. */
  onSaved: () => void;
};

/**
 * The "Set environment file" dialog (Issue #104; a bottom sheet on phones): the path inside
 * the repository and the content, with the warning before saving that it must hold test
 * values only, because the agent can read the file and could print or send it. The content is
 * sent once and never shown again: replacing means pasting it anew. The API checks the path
 * (relative, inside the repository, not in `.git`, not tracked) and the size; its field errors
 * land on the fields.
 */
export function EnvironmentFileDialog({
  projectId,
  open,
  onOpenChange,
  currentPath,
  onSaved,
}: EnvironmentFileDialogProps) {
  const save = useSetEnvironmentFile(projectId);
  const [path, setPath] = useState(currentPath ?? DEFAULT_ENVIRONMENT_FILE_PATH);
  const [content, setContent] = useState('');
  const [hints, setHints] = useState<Partial<Record<Field, string>>>({});
  const inFlight = useRef(false);
  const replacing = currentPath !== undefined;

  function close() {
    setPath(currentPath ?? DEFAULT_ENVIRONMENT_FILE_PATH);
    setContent('');
    setHints({});
    save.reset();
    onOpenChange(false);
  }

  function changeOpen(next: boolean) {
    if (next) onOpenChange(true);
    else if (!save.isPending) close();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const trimmedPath = path.trim();
    const local: Partial<Record<Field, string>> = {};
    if (trimmedPath === '') local.path = 'Enter a path inside the repository, e.g. .env.';
    if (new TextEncoder().encode(content).length > MAX_BYTES) {
      local.content = 'The content is larger than 64 KiB.';
    }
    setHints(local);
    if (Object.keys(local).length > 0) return;
    inFlight.current = true;
    try {
      await save.mutateAsync({ path: trimmedPath, content });
    } catch {
      return;
    } finally {
      inFlight.current = false;
    }
    close();
    onSaved();
  }

  const serverFieldErrors = fieldErrorsOf(save.error);
  const errors = { ...serverFieldErrors, ...hints };
  const serverError = save.error && Object.keys(serverFieldErrors).length === 0 ? save.error : null;
  const problem = serverError instanceof ApiError ? serverError.problem : undefined;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogHeader>
            <DialogTitle>
              {replacing ? 'Replace environment file' : 'Set environment file'}
            </DialogTitle>
            <DialogDescription>
              Studio writes this file into each run&apos;s working copy, readable by its owner only
              and never committed. Stored outside Git, write-only: Studio never shows the content
              again.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Banner tone="warning" icon={TriangleAlertIcon} title="Use test values only.">
              Never put production credentials here. The agent can read this file and could print or
              send its content.
            </Banner>
            {serverError ? (
              <Banner tone="danger" title={problem?.title}>
                {problem?.detail || 'Could not save the environment file. Try again.'}
              </Banner>
            ) : null}
            <TextField
              id="environment-file-path"
              label="Path in the repository"
              type="text"
              mono
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              help="Relative to the repository root, not tracked by Git, e.g. .env or apps/api/.env.test."
              error={errors.path}
              readOnly={save.isPending}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            <TextField
              id="environment-file-content"
              label="Content"
              multiline
              mono
              rows={8}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="DATABASE_URL=postgres://test:test@localhost:5432/test"
              help={
                replacing
                  ? 'Paste the whole file; it replaces the current one. Up to 64 KiB.'
                  : 'Up to 64 KiB of UTF-8 text.'
              }
              error={errors.content}
              readOnly={save.isPending}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={save.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save environment file'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
