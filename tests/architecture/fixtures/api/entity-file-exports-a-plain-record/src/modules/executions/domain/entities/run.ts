export interface Run {
  state: string;
}

export function isFinal(run: Run): boolean {
  return run.state === 'succeeded';
}
