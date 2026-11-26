import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions/limits';
import Link from 'next/link';

/**
 * The names of the skills the Run's agent had when it started, in the order recorded. A name that
 * is a valid skill name opens that skill; anything else is plain text, never a link.
 */
export function RunSkills({ skills }: { skills: readonly string[] }) {
  if (skills.length === 0) return <span className="text-text-dim">None</span>;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
      {skills.map((name, index) => (
        <li key={`${index}:${name}`} className="font-mono text-code break-all">
          {AGENT_NAME_PATTERN.test(name) ? (
            <Link href={`/agents/skills?${new URLSearchParams({ open: name })}`}>{name}</Link>
          ) : (
            name
          )}
        </li>
      ))}
    </ul>
  );
}
