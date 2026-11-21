'use client';

import { type ReactNode, useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { toast } from '@/shared/ui/sonner';
import { ApiError, type ProjectOutput } from '../../../../platform/api';
import { useSetMergeMethod } from '../../api/projects-queries';

type MergeMethod = ProjectOutput['mergeMethod'];

const TITLE_ID = 'merge-method-card-title';

const CHOICES: { value: MergeMethod; label: string; note: string; isDefault?: true }[] = [
  {
    value: 'squash',
    label: 'Squash',
    note: "One commit on the Integration branch, with the pull request's title and description.",
    isDefault: true,
  },
  {
    value: 'merge_commit',
    label: 'Merge commit',
    note: "Keeps the Run branch's commits and adds a merge commit with GitHub's own message.",
  },
];

function Choice({
  name,
  choice,
  checked,
  disabled,
  onSelect,
}: {
  name: string;
  choice: (typeof CHOICES)[number];
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}): ReactNode {
  const id = `${name}-${choice.value}`;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="radio"
        name={name}
        value={choice.value}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-note`}
        onChange={onSelect}
        className="mt-1 size-4 shrink-0 accent-brand pointer-coarse:size-5"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-body font-medium">
          {choice.label}
          {choice.isDefault ? (
            <span className="ml-2 text-small font-normal text-text-muted">(default)</span>
          ) : null}
        </label>
        <span id={`${id}-note`} className="text-small text-text-muted">
          {choice.note}
        </span>
      </div>
    </div>
  );
}

/**
 * How Studio merges this project's Runs. The Run page names it in its confirmation, and a Merge
 * approval records the one it used.
 */
export function MergeMethodCard({
  projectId,
  mergeMethod,
}: {
  projectId: string;
  mergeMethod: MergeMethod;
}) {
  const save = useSetMergeMethod(projectId);
  const [picked, setPicked] = useState<MergeMethod | null>(null);
  const name = useId();
  const choice = picked ?? mergeMethod;
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;

  function select(next: MergeMethod) {
    save.reset();
    setPicked(next);
  }

  function submit() {
    save.mutate(
      { mergeMethod: choice },
      {
        onSuccess: () => {
          setPicked(null);
          toast.success('Merge method saved');
        },
      },
    );
  }

  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <CardTitle id={TITLE_ID}>Merge method</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice !== mergeMethod && !save.isPending) submit();
          }}
        >
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-2 p-0 text-small text-text-muted">
              How &ldquo;Approve and merge&rdquo; merges a Run&apos;s pull request.
            </legend>
            {CHOICES.map((option) => (
              <Choice
                key={option.value}
                name={name}
                choice={option}
                checked={choice === option.value}
                disabled={save.isPending}
                onSelect={() => select(option.value)}
              />
            ))}
          </fieldset>
          {save.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not save the merge method. Try again.'}
            </Banner>
          ) : null}
          <p className="m-0 text-small text-text-muted">
            It applies to merges approved from now on. If the repository does not allow the method,
            GitHub refuses the merge and the Run page says so.
          </p>
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={choice === mergeMethod}
            >
              {save.isPending ? 'Saving…' : 'Save merge method'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
