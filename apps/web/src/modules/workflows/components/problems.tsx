/** A problem as the Workflows answer it. */
interface ProblemView {
  code: string;
  path: string;
  key: string | null;
  message: string;
}

/** Each problem of a Workflow with its place; a folder-level problem has an empty path. */
export function Problems({ problems }: { problems: ProblemView[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small text-run-failed">
      {problems.map((problem, index) => (
        <li key={`${problem.code}:${problem.path}:${problem.key ?? ''}:${index}`}>
          {problem.path === '' ? (
            <span>the Workflow&apos;s folder</span>
          ) : (
            <span className="font-mono text-code break-all">{problem.path}</span>
          )}
          {problem.key ? (
            <>
              {' · '}
              <code className="text-code">{problem.key}</code>
            </>
          ) : null}
          {' — '}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}
