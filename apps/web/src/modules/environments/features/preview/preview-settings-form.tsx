'use client';

import { type FormEvent, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { toast } from '@/shared/ui/sonner';
import {
  ApiError,
  type PreviewOutput,
  previewRefusalsOf,
  type SavePreviewSettingsResponseOutput,
} from '../../../../platform/api';
import { useSavePreviewSettings } from '../../api/preview-queries';
import { RefusalList } from './refusal-list';

const TITLE_ID = 'preview-settings-form-title';

/** The path a new Preview is prefilled with. */
export const DEFAULT_COMPOSE_FILE = 'compose.yaml';

const PORT_MIN = 1;
const PORT_MAX = 65535;
const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

type Field = 'composeFile' | 'service' | 'port';
type Hints = Partial<Record<Field, string>>;

const NOT_READY: Record<NonNullable<PreviewOutput['repository']['reason']>, string> = {
  no_repository: 'This project has no repository. Connect one before you set up a Preview.',
  repository_not_ready:
    'The repository is not ready: it is still connecting or fetching. You can set up the Preview when it is ready.',
  unsupported_platform:
    'Repository features run on Linux only, and this Studio API is not running on Linux.',
};

/** The API's field errors (400) by field. */
function fieldErrorsOf(error: unknown): Hints {
  if (!(error instanceof ApiError)) return {};
  const errors: Hints = {};
  for (const fieldError of error.problem?.errors ?? []) {
    const path = fieldError.path as Field;
    if (['composeFile', 'service', 'port'].includes(path) && !errors[path]) {
      errors[path] = fieldError.message;
    }
  }
  return errors;
}

type PreviewSettingsFormProps = {
  projectId: string;
  settings: PreviewOutput['settings'];
  repository: PreviewOutput['repository'];
};

/**
 * The three settings of the Preview. Studio reads the Compose file from the integration branch
 * and judges it when the form is saved; a refusal shows every reason with its place.
 */
export function PreviewSettingsForm({ projectId, settings, repository }: PreviewSettingsFormProps) {
  const save = useSavePreviewSettings(projectId);
  const [composeFile, setComposeFile] = useState(settings?.composeFile ?? DEFAULT_COMPOSE_FILE);
  const [service, setService] = useState(settings?.service ?? '');
  const [port, setPort] = useState(settings ? String(settings.port) : '');
  const [hints, setHints] = useState<Hints>({});
  const [saved, setSaved] = useState<SavePreviewSettingsResponseOutput | null>(null);
  const blocked = !repository.ready;

  function edit(change: () => void) {
    save.reset();
    setSaved(null);
    change();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending || blocked) return;
    const local: Hints = {};
    const trimmedFile = composeFile.trim();
    const trimmedService = service.trim();
    const portNumber = Number(port);
    if (trimmedFile === '') local.composeFile = 'Enter the path of the Compose file.';
    if (!SERVICE_PATTERN.test(trimmedService) || trimmedService.length > 63) {
      local.service = 'Enter a service name from the Compose file, e.g. web.';
    }
    if (
      port.trim() === '' ||
      !Number.isInteger(portNumber) ||
      portNumber < PORT_MIN ||
      portNumber > PORT_MAX
    ) {
      local.port = `Enter a whole number from ${PORT_MIN} to ${PORT_MAX}.`;
    }
    setHints(local);
    if (Object.keys(local).length > 0) return;
    setSaved(null);
    save.mutate(
      { composeFile: trimmedFile, service: trimmedService, port: portNumber },
      {
        onSuccess: (answer) => {
          setSaved(answer);
          toast.success('Preview settings saved');
        },
      },
    );
  }

  const refusals = previewRefusalsOf(save.error);
  const serverFieldErrors = fieldErrorsOf(save.error);
  const errors = { ...serverFieldErrors, ...hints };
  const otherError =
    save.error && refusals.length === 0 && Object.keys(serverFieldErrors).length === 0
      ? save.error
      : null;
  const problem = otherError instanceof ApiError ? otherError.problem : undefined;
  const removedPorts = saved?.removedPorts ?? [];

  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <CardTitle id={TITLE_ID}>Preview settings</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {blocked ? (
            <Banner tone="warning" title="The form is off.">
              {NOT_READY[repository.reason ?? 'repository_not_ready']}
            </Banner>
          ) : null}
          {refusals.length > 0 ? <RefusalList refusals={refusals} /> : null}
          {otherError ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not save the Preview settings. Try again.'}
            </Banner>
          ) : null}
          {saved && removedPorts.length > 0 ? (
            <Banner tone="info" title="Published ports were removed.">
              <p className="m-0 mb-1">
                The Preview starts without the ports the Compose file publishes on the host; only
                the service you chose is routed:
              </p>
              <ul aria-label="Removed ports" className="m-0 flex list-none flex-col gap-0.5 p-0">
                {removedPorts.map((removed) => (
                  <li key={removed.place}>
                    <code className="font-mono text-code break-all">{removed.place}</code>
                    <span className="text-text-muted"> · service {removed.service}</span>
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          <fieldset
            disabled={blocked}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0 disabled:opacity-60"
          >
            <TextField
              id="preview-compose-file"
              label="Compose file"
              type="text"
              mono
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              help="Path in the integration branch, relative to the repository root, e.g. compose.yaml or deploy/compose.yaml."
              error={errors.composeFile}
              readOnly={save.isPending}
              value={composeFile}
              onChange={(event) => edit(() => setComposeFile(event.target.value))}
            />
            <TextField
              id="preview-service"
              label="Service"
              type="text"
              mono
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              help="The service in the Compose file that serves the app, e.g. web."
              error={errors.service}
              readOnly={save.isPending}
              value={service}
              onChange={(event) => edit(() => setService(event.target.value))}
            />
            <TextField
              id="preview-port"
              label="Port"
              type="text"
              inputMode="numeric"
              mono
              autoComplete="off"
              help="The port that service listens on inside its container, e.g. 3000."
              error={errors.port}
              readOnly={save.isPending}
              value={port}
              onChange={(event) => edit(() => setPort(event.target.value))}
            />
          </fieldset>
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={blocked}>
              {save.isPending ? 'Checking and saving…' : 'Save Preview settings'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
