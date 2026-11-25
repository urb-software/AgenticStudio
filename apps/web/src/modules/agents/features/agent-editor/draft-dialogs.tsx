'use client';

import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { useId, useState, type FormEvent } from 'react';
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
import { Label } from '@/shared/ui/label';
import { NativeSelect } from '@/shared/ui/native-select';
import type { ProviderAvailabilityOutput } from '../../../../platform/api';
import { draftFailureOf } from '../../api/draft-queries';
import { formatSize } from '../../components/format-size';
import { agentNameError, pathError } from './draft-model';

/** The file content a dialog hands on: text, or bytes as base64. */
export type FileContent = { text: string } | { contentBase64: string };

interface DialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Runs `action`; a failure becomes the message the dialog shows instead of closing. */
function useDialogAction(onOpenChange: (open: boolean) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    try {
      await action();
      onOpenChange(false);
    } catch (failure) {
      setError(draftFailureOf(failure).message);
    } finally {
      setPending(false);
    }
  }
  function changeOpen(next: boolean) {
    if (pending) return;
    if (!next) setError(undefined);
    onOpenChange(next);
  }
  return { pending, error, run, changeOpen };
}

interface ConfirmDialogProps extends DialogShellProps {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** What the action does, and what it keeps. */
  consequences: readonly string[];
  action: () => Promise<void>;
}

/** The confirm of a destructive Draft action (design system: "Destructive = confirm"). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  consequences,
  action,
}: ConfirmDialogProps) {
  const { pending, error, run, changeOpen } = useDialogAction(onOpenChange);
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            {consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={pending} onClick={() => void run(action)}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The bytes of a chosen file as standard base64. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

type FileDialogMode = 'add' | 'rename' | 'replace';

const FILE_DIALOG: Record<FileDialogMode, { title: string; submit: string }> = {
  add: { title: 'Add a file', submit: 'Add file' },
  rename: { title: 'Rename or move a file', submit: 'Rename' },
  replace: { title: 'Replace a file', submit: 'Replace file' },
};

interface FileDialogProps extends DialogShellProps {
  mode: FileDialogMode;
  /** The path to start from: the file for a rename or a replace, a folder for an add. */
  initialPath: string;
  existing: ReadonlySet<string>;
  /** Paths the Draft deletes, which a new file may take. */
  deleted: ReadonlySet<string>;
  /** `content` is undefined for a rename. */
  action: (path: string, content: FileContent | undefined) => Promise<void>;
}

/** Add (with an optional upload), rename and replace-with-an-upload share one form. */
export function FileDialog({
  open,
  onOpenChange,
  mode,
  initialPath,
  existing,
  deleted,
  action,
}: FileDialogProps) {
  const { pending, error, run, changeOpen } = useDialogAction(onOpenChange);
  const [path, setPath] = useState(initialPath);
  const [upload, setUpload] = useState<File>();
  const [touched, setTouched] = useState(false);
  const uploadId = useId();
  const { title, submit } = FILE_DIALOG[mode];

  const taken = mode === 'replace' ? new Set<string>() : existing;
  const pathProblem = mode === 'replace' ? undefined : pathError(path, taken, deleted);
  const uploadProblem =
    upload && upload.size > MAX_FILE_BYTES
      ? `This file is ${formatSize(upload.size)}; a file may be at most ${formatSize(MAX_FILE_BYTES)}.`
      : mode === 'replace' && !upload && touched
        ? 'Choose the file to upload.'
        : undefined;

  function submitForm(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (pathProblem || uploadProblem || (mode === 'replace' && !upload)) return;
    void run(async () => {
      if (mode === 'rename') return action(path, undefined);
      if (upload) return action(path, { contentBase64: await base64Of(upload) });
      return action(path, { text: '' });
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submitForm} noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Paths are relative to the Repository root. The change goes into the Draft only.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <TextField
              label="Path"
              mono
              value={path}
              readOnly={mode === 'replace'}
              onChange={(event) => setPath(event.target.value)}
              error={touched ? pathProblem : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {mode === 'rename' ? null : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={uploadId}>
                  {mode === 'replace' ? 'File to upload' : 'File to upload (optional)'}
                </Label>
                <input
                  id={uploadId}
                  type="file"
                  className="text-small"
                  aria-invalid={uploadProblem ? true : undefined}
                  aria-describedby={uploadProblem ? `${uploadId}-problem` : undefined}
                  onChange={(event) => setUpload(event.target.files?.[0])}
                />
                <p className="m-0 text-small text-text-muted">
                  Up to {formatSize(MAX_FILE_BYTES)}. Without a file, an empty text file is added.
                </p>
                {uploadProblem ? (
                  <p
                    id={`${uploadId}-problem`}
                    role="alert"
                    className="m-0 text-small text-run-failed"
                  >
                    {uploadProblem}
                  </p>
                ) : null}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={pending}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface NewAgentDialogProps extends DialogShellProps {
  providers: readonly ProviderAvailabilityOutput[];
  /** The names of the agent folders that exist, in the Repository or the Draft. */
  taken: ReadonlySet<string>;
  action: (name: string, provider: string) => Promise<void>;
}

/** Asks for a name and a Provider; the new `AGENT.md` comes from a template that validates. */
export function NewAgentDialog({
  open,
  onOpenChange,
  providers,
  taken,
  action,
}: NewAgentDialogProps) {
  const { pending, error, run, changeOpen } = useDialogAction(onOpenChange);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const first = providers.find((provider) => provider.available) ?? providers[0];
  const [chosen, setChosen] = useState<string>();
  const provider = chosen ?? first?.id ?? '';
  const providerId = useId();
  const nameProblem = agentNameError(name, taken);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (nameProblem || provider === '') return;
    void run(() => action(name, provider));
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Creates <code className="text-code">agents/&lt;name&gt;/AGENT.md</code> in the Draft.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <TextField
              label="Name"
              mono
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={touched ? nameProblem : undefined}
              help="Lower-case letters, digits and hyphens."
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={providerId}>Provider</Label>
              <NativeSelect
                id={providerId}
                value={provider}
                onChange={(event) => setChosen(event.target.value)}
              >
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.available ? '' : ' (not available now)'}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={pending}>
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface LeaveDialogProps extends DialogShellProps {
  onLeave: () => void;
}

/** Asked when a link would leave the editor with unsaved edits. */
export function LeaveDialog({ open, onOpenChange, onLeave }: LeaveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Leave with unsaved edits?</DialogTitle>
          <DialogDescription>
            Edits you have not saved are kept in this tab until it closes, but they are not in the
            Draft.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Stay</Button>
          </DialogClose>
          <Button variant="destructive" onClick={onLeave}>
            Leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
