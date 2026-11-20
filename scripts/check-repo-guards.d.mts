export const DESIGN_SYSTEM_COPY: string;
export const DESIGN_SYSTEM_SOURCE: string;
export function checkDesignSystemCopy(read: (path: string) => Buffer | null): string[];
export function conflictMarkers(file: string, content: Buffer): string[];
export function checkRepository(root: string, files: string[]): string[];
