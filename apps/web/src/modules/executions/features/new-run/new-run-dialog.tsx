'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PlayIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type Resolver, useForm, useWatch } from 'react-hook-form';
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
import { NativeSelect } from '@/shared/ui/native-select';
import { Label } from '@/shared/ui/label';
import { ApiError, type StartRunRequest, startRunRequestHint } from '../../../../platform/api';
import {
  useProviderAvailability,
  useRunAgents,
  useRunProject,
  useRunWorkflows,
  useStartRun,
} from '../../api/runs-queries';
import { PROVIDER_LABEL } from '../../components/run-presentation';
import { startRefusalOf } from '../../components/start-refusal';

type Provider = keyof typeof PROVIDER_LABEL;

/** Plain messages for the client-side checks; the generated schema has zod's defaults. */
function hintMessage(issue: {
  code?: string;
  maximum?: unknown;
  path?: readonly PropertyKey[];
}): string | undefined {
  if (issue.path?.[0] === 'agent') return 'Choose an agent or a Workflow.';
  if (issue.code === 'too_small') return 'Enter a task.';
  if (issue.code === 'too_big') return `Use at most ${String(issue.maximum)} characters.`;
  return undefined;
}

const checkHint = zodResolver(startRunRequestHint, { error: hintMessage });

/**
 * What the form holds: the one choice of an agent (its name) or a Workflow (`workflow:` and its
 * name; an agent name never holds a colon). The Provider is not chosen, it follows from the agent.
 */
type Values = { task: string; agent: string };

const WORKFLOW_PREFIX = 'workflow:';

/** The request the choice stands for: an agent or a Workflow, never both. */
function toRequest(values: Values): StartRunRequest {
  return values.agent.startsWith(WORKFLOW_PREFIX)
    ? { task: values.task, workflow: values.agent.slice(WORKFLOW_PREFIX.length) }
    : { task: values.task, agent: values.agent };
}

/**
 * Checks the hint against the trimmed Task, because the API trims it before measuring (its
 * start-run schema); the value sent is the operator's text, and the API's answer is final.
 */
const resolver: Resolver<Values> = async (values, context, options) => {
  const checked = await checkHint(
    { ...toRequest(values), task: values.task.trim() },
    context,
    options as never,
  );
  // The form keeps its own shape: only the errors come from the request's checks.
  return Object.keys(checked.errors).length > 0
    ? { values: {}, errors: checked.errors }
    : { values, errors: {} };
};

type Field = 'task' | 'agent';
const FIELDS: readonly Field[] = ['task', 'agent'];

/** Server field errors (422 `errors[]`) that this form can show next to a field. */
function fieldErrorsOf(error: unknown): [Field, string][] {
  if (!(error instanceof ApiError) || error.status !== 422) return [];
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
  /** Prefill ("Run again": the same Task and agent or Workflow); the defaults are an empty Task and what the project offers first. */
  initialValues?: { task: string; agent?: string; workflow?: string };
};

const EMPTY = { task: '', agent: '' };

/**
 * Preselects the agent the server offers first unless the prefilled one is usable. An agent
 * whose Provider is switched off is shown with the reason and never selected; if availability
 * cannot be read, every agent is offered and the server decides.
 */
export function NewRunDialog({
  projectId,
  open,
  onOpenChange,
  initialValues = EMPTY,
}: NewRunDialogProps) {
  const router = useRouter();
  const id = useId();
  const AGENT_ID = `${id}-agent`;
  const AGENT_ERROR_ID = `${id}-agent-error`;
  const AGENT_FACTS_ID = `${id}-agent-facts`;
  const REASON_ID = `${id}-reason`;
  const startRun = useStartRun(projectId);
  // Counts openings, updated while rendering so the first render of an opening already uses a
  // fresh entry (and never an earlier opening's answer).
  const [wasOpen, setWasOpen] = useState(open);
  const [opening, setOpening] = useState(open ? 1 : 0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpening((count) => count + 1);
  }
  const agents = useRunAgents(projectId, opening, open);
  const availability = useProviderAvailability(opening, open);
  const workflowList = useRunWorkflows(opening, open);
  const project = useRunProject(open ? projectId : undefined);
  // Whether the operator chose the agent, so a fallback is only explained when we made it.
  const [picked, setPicked] = useState(false);
  const checking =
    (agents.isPending && !agents.isError) ||
    (availability.isPending && !availability.isError) ||
    (workflowList.isPending && !workflowList.isError) ||
    (project.isPending && !project.isError);
  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver,
    defaultValues: {
      task: initialValues.task,
      agent: initialValues.workflow
        ? `${WORKFLOW_PREFIX}${initialValues.workflow}`
        : (initialValues.agent ?? ''),
    },
  });

  // Why each unavailable Provider is unavailable; empty until the availability is read.
  const unavailable = useMemo(
    () =>
      new Map<Provider, string>(
        (availability.data ?? []).flatMap((provider) =>
          provider.available ? [] : [[provider.id, provider.reason ?? 'Unavailable'] as const],
        ),
      ),
    [availability.data],
  );
  const offered = agents.data?.agents ?? [];
  const workflows = useMemo(() => workflowList.data ?? [], [workflowList.data]);
  const noneUsable =
    offered.every((agent) => unavailable.has(agent.provider)) && workflows.length === 0;

  // The chosen agent is kept while it can start a Run, else the one offered first, else the
  // first that can. Worked out while rendering; the effect only copies it into the form.
  const formAgent = useWatch({ control, name: 'agent' }) ?? '';
  const chosenName = useMemo(() => {
    if (!open || checking || !agents.data) return formAgent;
    const list = agents.data.agents;
    const usableAgent = (name: string | undefined) =>
      list.find((agent) => agent.name === name && !unavailable.has(agent.provider))?.name;
    const usableWorkflow = (name: string | null | undefined) =>
      workflows.find((workflow) => workflow.name === name)?.name;
    const asWorkflow = (name: string | undefined) =>
      name === undefined ? undefined : `${WORKFLOW_PREFIX}${name}`;
    const isWorkflow = formAgent.startsWith(WORKFLOW_PREFIX);
    // The chosen one is kept while it can start a Run, else the project's default Workflow, the
    // agent the server offers first, the first agent that can, the first Workflow.
    return (
      (isWorkflow
        ? asWorkflow(usableWorkflow(formAgent.slice(WORKFLOW_PREFIX.length)))
        : usableAgent(formAgent)) ??
      asWorkflow(usableWorkflow(project.data?.defaultWorkflow)) ??
      usableAgent(agents.data.preselected) ??
      list.find((agent) => !unavailable.has(agent.provider))?.name ??
      asWorkflow(workflows[0]?.name) ??
      ''
    );
  }, [open, checking, agents.data, unavailable, formAgent, workflows, project.data]);
  useEffect(() => {
    if (chosenName !== (getValues('agent') ?? '')) setValue('agent', chosenName);
  }, [chosenName, opening, getValues, setValue]);
  const chosen = offered.find((agent) => agent.name === chosenName);
  const chosenWorkflow = chosenName.startsWith(WORKFLOW_PREFIX)
    ? workflows.find((workflow) => workflow.name === chosenName.slice(WORKFLOW_PREFIX.length))
    : undefined;
  // The server's reason describes the preselected agent, so it shows only while that is chosen.
  const reason =
    agents.data && chosenName === agents.data.preselected
      ? (agents.data.preselectedReason ?? null)
      : null;
  const wantedWorkflow = initialValues.workflow
    ? `${WORKFLOW_PREFIX}${initialValues.workflow}`
    : '';
  const wanted = wantedWorkflow || initialValues.agent || agents.data?.preselected;
  const hasChoice = chosen !== undefined || chosenWorkflow !== undefined;
  const fallbackFrom = picked || !hasChoice || !wanted || wanted === chosenName ? null : wanted;
  const wantedWhy =
    fallbackFrom && !fallbackFrom.startsWith(WORKFLOW_PREFIX)
      ? offered.find((agent) => agent.name === fallbackFrom)
      : undefined;
  const label = (choice: string) =>
    choice.startsWith(WORKFLOW_PREFIX) ? choice.slice(WORKFLOW_PREFIX.length) : choice;
  const fallbackNote = fallbackFrom
    ? wantedWhy && unavailable.has(wantedWhy.provider)
      ? `${fallbackFrom} cannot start a run now (${PROVIDER_LABEL[wantedWhy.provider]}: ${unavailable.get(wantedWhy.provider)}), so ${label(chosenName)} is chosen.`
      : `${label(fallbackFrom)} is not offered any more, so ${label(chosenName)} is chosen.`
    : null;

  const submitting = isSubmitting || startRun.isPending;
  // The select is disabled while submitting, so a server error for it takes focus afterwards.
  const agentError = errors.agent?.message;
  useEffect(() => {
    if (agentError && !submitting) document.getElementById(AGENT_ID)?.focus();
  }, [agentError, submitting, AGENT_ID]);
  // The disabled button stops clicks; this stops a second submit by other means (Enter, script).
  const inFlight = useRef(false);

  function close() {
    reset();
    setPicked(false);
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

  async function onSubmit(values: Values) {
    let runId: string;
    try {
      runId = (await startRun.mutateAsync(toRequest(values))).id;
    } catch (cause) {
      inFlight.current = false;
      fieldErrorsOf(cause).forEach(([field, message], index) =>
        setError(field, { type: 'server', message }, { shouldFocus: index === 0 }),
      );
      // The offered agents are out of date: read them again (the selection follows the list).
      const refused = startRefusalOf(cause);
      if (refused.refreshAgents) {
        void agents.refetch();
        void workflowList.refetch();
      }
      // The Provider went off after the dialog opened: the agent becomes disabled with its reason.
      if (refused.refreshProviders) void availability.refetch();
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
  const refusal = startRefusalOf(serverError);

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
                {refusal.message || problem?.detail || 'Could not start the run. Try again.'}
                {refusal.message && refusal.showDetail && problem?.detail ? (
                  <span className="mt-1 block">{problem.detail}</span>
                ) : null}
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
              <Label htmlFor={AGENT_ID} className="mb-1.5">
                Agent or Workflow
              </Label>
              {checking ? (
                <p role="status" className="m-0 text-code text-text-muted">
                  Checking the agents…
                </p>
              ) : agents.isError ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="m-0 text-code text-run-failed">Couldn&apos;t load the agents.</p>
                  <Button type="button" size="sm" onClick={() => void agents.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : (
                <>
                  <NativeSelect
                    id={AGENT_ID}
                    aria-invalid={errors.agent ? true : undefined}
                    aria-describedby={
                      [
                        AGENT_FACTS_ID,
                        reason ? REASON_ID : undefined,
                        errors.agent ? AGENT_ERROR_ID : undefined,
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    disabled={submitting}
                    value={chosenName}
                    {...register('agent', { onChange: () => setPicked(true) })}
                  >
                    <optgroup label="Agents">
                      {offered.map((agent) => {
                        const why = unavailable.get(agent.provider);
                        return (
                          <option key={agent.name} value={agent.name} disabled={why !== undefined}>
                            {why === undefined
                              ? `${agent.name} · ${PROVIDER_LABEL[agent.provider]}`
                              : `${agent.name} (${PROVIDER_LABEL[agent.provider]}: ${why})`}
                          </option>
                        );
                      })}
                    </optgroup>
                    {workflows.length > 0 ? (
                      <optgroup label="Workflows">
                        {workflows.map((workflow) => (
                          <option key={workflow.name} value={`${WORKFLOW_PREFIX}${workflow.name}`}>
                            {workflow.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </NativeSelect>
                  <div id={AGENT_FACTS_ID} className="mt-2 flex flex-col gap-1">
                    {chosenWorkflow ? (
                      <>
                        <span className="text-caption font-medium text-text-dim">Workflow</span>
                        <p data-testid="workflow-facts" className="m-0 text-body">
                          {chosenWorkflow.name}: its Phases run one after another, each with its own
                          agent, on one branch and one pull request.
                        </p>
                        {chosenWorkflow.description ? (
                          <p className="m-0 text-small break-words whitespace-pre-wrap text-text-muted">
                            {chosenWorkflow.description}
                          </p>
                        ) : null}
                      </>
                    ) : chosen ? (
                      <>
                        <span className="text-caption font-medium text-text-dim">Provider</span>
                        <p data-testid="agent-provider" className="m-0 text-body">
                          {PROVIDER_LABEL[chosen.provider]} · model {chosen.model}
                        </p>
                        {chosen.description ? (
                          <p className="m-0 text-small break-words whitespace-pre-wrap text-text-muted">
                            {chosen.description}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  {reason ? (
                    <p
                      id={REASON_ID}
                      data-testid="preselected-reason"
                      className="mt-1.5 mb-0 text-code break-words whitespace-pre-wrap text-text-muted"
                    >
                      {reason}
                    </p>
                  ) : null}
                  {fallbackNote ? (
                    <p
                      data-testid="agent-fallback-note"
                      className="mt-1.5 mb-0 text-code break-words text-text-muted"
                    >
                      {fallbackNote}
                    </p>
                  ) : null}
                  {noneUsable && offered.length > 0 && !availability.isError ? (
                    <p className="mt-1.5 mb-0 text-code text-text-muted">
                      No agent can start a run now: every Provider is switched off.
                    </p>
                  ) : null}
                  {workflowList.isError ? (
                    <p className="mt-1.5 mb-0 text-code text-text-muted">
                      Couldn&apos;t load the Workflows; only agents are offered.
                    </p>
                  ) : null}
                </>
              )}
              {availability.isError ? (
                <p className="mt-1.5 mb-0 text-code text-text-muted">
                  Couldn&apos;t check which providers are available.
                </p>
              ) : null}
              {errors.agent?.message ? (
                <p
                  id={AGENT_ERROR_ID}
                  role="alert"
                  className="mt-1.5 mb-0 flex items-center gap-1.5 text-code text-run-failed"
                >
                  <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  {errors.agent.message}
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
            <Button
              type="submit"
              variant="primary"
              icon={PlayIcon}
              loading={submitting}
              disabled={
                checking ||
                agents.isError ||
                (!chosenWorkflow && (!chosen || unavailable.has(chosen.provider)))
              }
            >
              {submitting ? 'Starting…' : 'Start run'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
