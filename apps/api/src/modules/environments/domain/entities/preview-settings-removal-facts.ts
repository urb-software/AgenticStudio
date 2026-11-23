/** What removing the settings must know from outside the aggregate. */
export interface PreviewSettingsRemovalFacts {
  /** Whether the Project's Preview is running. */
  readonly previewRunning: boolean;
}
