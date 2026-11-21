/** A commit id, branch name or other code-like text that may break anywhere. */
export function Mono({ children }: { children: string }) {
  return <code className="font-mono text-code break-all text-text">{children}</code>;
}
