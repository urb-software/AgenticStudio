/**
 * The instructions the Run's agent worked from, as a copy kept on the Run. Plain text only: the
 * text is the operator's definition file, so it is never read as Markdown or HTML and never
 * made into a link (frontend.md §7, "Untrusted text"). Collapsed until the operator opens it.
 */
export function RunAgentInstructions({ instructions }: { instructions: string }) {
  return (
    <details data-slot="agent-instructions" className="group min-w-0">
      <summary className="cursor-pointer rounded-sm text-brand outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Show instructions
      </summary>
      <pre
        data-testid="agent-instructions-text"
        tabIndex={0}
        aria-label="Agent instructions"
        className="mt-2 mb-0 max-h-96 overflow-auto rounded-md border border-border bg-bg-subtle p-3 font-mono text-code break-words whitespace-pre-wrap text-text"
      >
        {instructions}
      </pre>
    </details>
  );
}
