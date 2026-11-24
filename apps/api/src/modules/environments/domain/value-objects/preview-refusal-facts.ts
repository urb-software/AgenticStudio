/** One reason a stack was refused, as the controller reports it; fixed wording, never a value from the file. */
export interface PreviewRefusalFacts {
  readonly code: string;
  readonly place: string;
  readonly message: string;
}
