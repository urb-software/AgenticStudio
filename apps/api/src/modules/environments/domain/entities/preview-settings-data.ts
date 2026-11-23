/** What a Project's Preview settings are restored from. */
export interface PreviewSettingsData {
  /** The Project they belong to: at most one set of settings per Project. */
  readonly projectId: string;
  readonly composeFile: string;
  readonly service: string;
  readonly port: number;
  readonly updatedAt: Date;
}
