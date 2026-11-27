/** One thing a review found: the reviewer's text (redacted), and where, when it says. */
export interface RunPhaseFinding {
  text: string;
  file?: string;
  line?: number;
}
