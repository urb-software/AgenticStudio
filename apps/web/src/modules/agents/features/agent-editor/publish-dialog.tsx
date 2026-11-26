'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import type { AgentDraftFileOutput } from '../../../../platform/api';
import { draftFailureOf, publishFailureOf, usePublishDraft } from '../../api/draft-queries';
import type { PublishFailure } from '../../api/draft-queries';
import { ChangesView } from './changes-view';
import { PUBLISH_MESSAGE_MAX, publishMessageError } from './draft-model';

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * The result of a publish. Focus moves here when it appears, and the live region is filled one
 * render after it exists, so a screen reader announces the text.
 */
function PublishedStatus({
  commit,
  keptFiles,
  onDiscard,
}: {
  commit: string;
  keptFiles: number;
  onDiscard: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    box.current?.focus();
    const timer = setTimeout(() => setAnnounced(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={box} tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <div role="status" className="flex flex-col gap-2">
        {announced ? (
          <>
            <p className="m-0">
              Published as commit{' '}
              <code className="text-code" title={commit}>
                {shortSha(commit)}
              </code>
              {keptFiles === 0
                ? '. The Draft is empty, and the editor now reads that commit.'
                : '. The editor now reads that commit.'}
            </p>
            {keptFiles > 0 ? (
              <p className="m-0 text-run-failed">
                Changes were saved to the Draft while it was being published. They are kept on the
                old commit and cannot be published. Copy what you need, then discard the Draft and
                make those changes again.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {keptFiles > 0 ? (
        <div>
          <Button size="sm" variant="danger" onClick={onDiscard}>
            Discard the Draft
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Draft as the page shows it: what is published is exactly these files at this version. */
  files: readonly AgentDraftFileOutput[];
  baseCommit: string;
  version: number;
  /** Draft files that also changed in the Repository since the Draft began. */
  movedUpstream: readonly string[];
  /** The Draft changed elsewhere: read it again. */
  onReload: () => void;
  /** The Draft cannot be published any more: ask to discard it. */
  onDiscard: () => void;
  /** Reverts each path in the Draft, one after the other. */
  onRevertPaths: (paths: readonly string[]) => Promise<void>;
  /** The Repository has a new commit and the Draft is gone. */
  onPublished: () => void;
}

/**
 * Shows the Draft's changes once more and asks for the commit message. Every refusal of the API
 * stays in the dialog with its own message and, where there is one, its way out.
 */
export function PublishDialog({
  open,
  onOpenChange,
  files,
  baseCommit,
  version,
  movedUpstream,
  onReload,
  onDiscard,
  onRevertPaths,
  onPublished,
}: PublishDialogProps) {
  const publish = usePublishDraft();
  // One request at a time from this page, also when a second click lands before a re-render.
  const inFlight = useRef(false);
  const [message, setMessage] = useState('');
  const [touched, setTouched] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [failure, setFailure] = useState<PublishFailure>();
  const [reverting, setReverting] = useState(false);
  const [commit, setCommit] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  // The busy button lost focus: it goes to the message field. The alert announces itself, once.
  useEffect(() => {
    if (failure) form.current?.querySelector('textarea')?.focus();
  }, [failure]);
  const pending = publish.isPending || reverting;
  const problem = publishMessageError(message);

  function changeOpen(next: boolean) {
    if (pending) return;
    onOpenChange(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (problem || inFlight.current) return;
    inFlight.current = true;
    setFailure(undefined);
    try {
      const result = await publish.mutateAsync({ message, baseCommit, version });
      setCommit(result.commit);
      onPublished();
    } catch (error) {
      setFailure(publishFailureOf(error));
    } finally {
      inFlight.current = false;
    }
  }

  async function revert(paths: readonly string[]) {
    setReverting(true);
    try {
      await onRevertPaths(paths);
      onOpenChange(false);
    } catch (error) {
      setFailure({ kind: 'other', message: draftFailureOf(error).message });
    } finally {
      setReverting(false);
    }
  }

  if (commit !== undefined) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Published</DialogTitle>
            <DialogDescription>
              The Draft is now one commit on the Integration branch of the definitions Repository.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <PublishedStatus commit={commit} keptFiles={files.length} onDiscard={onDiscard} />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="primary">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const cannotRetry = failure?.kind === 'repository-moved' || failure?.kind === 'base-missing';
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="md:max-w-4xl">
        <form
          ref={form}
          onSubmit={(event) => void submit(event)}
          noValidate
          className="flex min-h-0 flex-col"
        >
          <DialogHeader>
            <DialogTitle>Publish the Draft</DialogTitle>
            <DialogDescription>
              {files.length === 1 ? '1 file changes' : `${files.length} files change`} in one commit
              on the Integration branch of the definitions Repository, as it stands now.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {failure ? (
              <div>
                <Banner
                  tone="danger"
                  action={
                    failure.kind === 'conflict' || failure.kind === 'failed' ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          onReload();
                          onOpenChange(false);
                        }}
                      >
                        Reload the Draft
                      </Button>
                    ) : failure.kind === 'repository-moved' || failure.kind === 'base-missing' ? (
                      <Button size="sm" variant="danger" onClick={onDiscard}>
                        Discard the Draft
                      </Button>
                    ) : failure.kind === 'outside-agents' ? (
                      <Button
                        size="sm"
                        loading={reverting}
                        onClick={() => void revert(failure.paths)}
                      >
                        Revert these files
                      </Button>
                    ) : undefined
                  }
                >
                  {failure.message}
                </Banner>
              </div>
            ) : null}
            {failure?.kind === 'problems' ? (
              <ul
                aria-label="Problems of the Draft"
                className="m-0 flex list-none flex-col gap-1 p-0 text-small"
              >
                {failure.problems.map(({ path, key, message: text }, index) => (
                  <li key={`${path}:${key ?? ''}:${index}`} className="text-run-failed">
                    <span className="font-mono text-code break-all">{path}</span>
                    {key ? (
                      <>
                        {' · '}
                        <code className="text-code">{key}</code>
                      </>
                    ) : null}
                    {' — '}
                    {text}
                  </li>
                ))}
              </ul>
            ) : null}
            {failure?.kind === 'outside-agents' ? (
              <ul
                aria-label="Paths outside agents/"
                className="m-0 flex list-none flex-col gap-1 p-0 text-small"
              >
                {failure.paths.map((path) => (
                  <li key={path} className="font-mono text-code break-all">
                    {path}
                  </li>
                ))}
              </ul>
            ) : null}
            {failure?.kind === 'repository-moved' && movedUpstream.length > 0 ? (
              <div className="text-small">
                These Draft files also changed in the Repository:
                <ul className="m-0 mt-1 list-disc pl-5">
                  {movedUpstream.map((path) => (
                    <li key={path} className="font-mono text-code break-all">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <TextField
              label="Commit message"
              multiline
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              error={touched ? problem : undefined}
              help={`The first line is the subject. Up to ${PUBLISH_MESSAGE_MAX.toLocaleString('en-US')} characters. The author is the one Studio is set up with.`}
              autoComplete="off"
            />
            <div className="overflow-hidden rounded-md border border-border">
              <ChangesView
                compact
                files={files}
                baseCommit={baseCommit}
                selected={selected}
                onSelect={setSelected}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              loading={publish.isPending}
              disabled={cannotRetry}
            >
              Publish
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
