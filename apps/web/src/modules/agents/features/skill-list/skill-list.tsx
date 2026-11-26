'use client';

import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions';
import { useId, useState } from 'react';
import { RefreshCwIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { type SkillListOutput, type SkillSummaryOutput } from '../../../../platform/api';
import { useSkills } from '../../api/skills-queries';
import { editorHref, readRequestOf, shortSha } from '../../components/definitions-view';
import { Problems } from '../../components/problems';
import { SkillDetail } from '../skill-detail/skill-detail';

const READ_REQUEST = 'GET /api/skills';
const TITLE_ID = 'skills-title';

/** Why no (or only the last known) skills can be read, or null when all is well. */
function repositoryReason(list: SkillListOutput): string | null {
  if (list.repository === null) {
    return 'No definitions Repository is connected, so there are no skills to list. Connect it on the Agents page.';
  }
  if (list.repository.note) return list.repository.note;
  if (list.commit === null) {
    return 'Nothing has been fetched from the definitions Repository yet, so there are no skills to list. Fetch it on the Agents page.';
  }
  return null;
}

const TRUNCATED = 'More skill folders exist than are listed here.';

function SkillRow({
  skill,
  commit,
  open,
  onToggle,
}: {
  skill: SkillSummaryOutput;
  commit: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const openable = AGENT_NAME_PATTERN.test(skill.name);
  const hasEntry = openable && !skill.problems.some((problem) => problem.code === 'entry_missing');
  return (
    <li className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-code font-semibold break-all">{skill.name}</span>
        {skill.valid ? (
          <span className="text-caption font-medium whitespace-nowrap text-run-succeeded">
            Valid
          </span>
        ) : (
          <span className="text-caption font-medium whitespace-nowrap text-run-failed">
            Not valid
          </span>
        )}
        {hasEntry ? (
          <Button asChild className="ml-auto">
            <Link href={editorHref(`skills/${skill.name}/SKILL.md`)}>
              Open in editor<span className="sr-only"> ({skill.name})</span>
            </Link>
          </Button>
        ) : null}
        {openable ? (
          <Button
            className={hasEntry ? undefined : 'ml-auto'}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} ${skill.name}`}
            onClick={onToggle}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        ) : null}
      </div>
      {skill.valid ? (
        skill.description ? (
          <p className="m-0 text-small text-text-muted">{skill.description}</p>
        ) : null
      ) : (
        <Problems problems={skill.problems} subject="skill" />
      )}
      {open && openable ? (
        <div id={detailId} className="mt-1 border-t border-border pt-3">
          <SkillDetail name={skill.name} commit={commit} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The skills of the definitions Repository at its last fetched commit, each with its validation
 * state. The list is read again on window focus. Everything shown is text.
 */
export function SkillList() {
  const { data, error, isPending, isError, isRefetching, refetch } = useSkills();
  // One skill is open at a time; a link from an agent opens its skill.
  const opened = useSearchParams().get('open') ?? undefined;
  const [openName, setOpenName] = useState<string | undefined>(opened);

  const heading = <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Skills</h1>;
  const back = (
    <Link href="/agents" className="text-small">
      Back to Agents
    </Link>
  );

  if (isPending) {
    return (
      <>
        {heading}
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading the skills"
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-3.5 w-64 max-w-full" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        {heading}
        <EmptyState
          tone="error"
          icon={TriangleAlertIcon}
          title="Couldn't load the skills"
          description={
            <span className="font-mono text-small">{readRequestOf(READ_REQUEST, error)}</span>
          }
          action={
            <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
        {back}
      </>
    );
  }

  const reason = repositoryReason(data);
  if (data.skills.length === 0) {
    return (
      <>
        {heading}
        <EmptyState
          icon={SparklesIcon}
          title={
            data.commit === null
              ? 'No skills to show yet'
              : 'No skills in the definitions Repository'
          }
          description={
            reason ??
            'A skill is a folder skills/<name>/ with a SKILL.md file. Add one to the definitions Repository, push it, and fetch the Repository on the Agents page.'
          }
          action={
            <Button asChild>
              <Link href="/agents">Go to Agents</Link>
            </Button>
          }
        />
        {data.truncated ? <Banner tone="warning">{TRUNCATED}</Banner> : null}
      </>
    );
  }
  return (
    <>
      {heading}
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader>
          <CardTitle id={TITLE_ID}>Skills</CardTitle>
          <span className="text-small text-text-muted">
            {data.commit ? (
              <>
                Read at commit{' '}
                <code className="text-code" title={data.commit}>
                  {shortSha(data.commit)}
                </code>
              </>
            ) : (
              'No commit read'
            )}
          </span>
        </CardHeader>
        <CardContent flush>
          {reason ? (
            <Banner tone="warning" className="m-4">
              {reason}
            </Banner>
          ) : null}
          {data.truncated ? (
            <Banner tone="warning" className="m-4">
              {TRUNCATED}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {data.skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                commit={data.commit}
                open={openName === skill.name}
                onToggle={() => setOpenName(openName === skill.name ? undefined : skill.name)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
      {back}
    </>
  );
}
