/** What removing the settings must know from outside the aggregate. */
export interface PreviewSettingsRemovalFacts {
  /** Whether the Project's Preview is running; the Preview state supplies it once it exists. */
  readonly previewRunning: boolean;
}
