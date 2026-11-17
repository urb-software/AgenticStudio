// The root's current values as read-only plain data: what handlers return and repositories read.
export interface ProductSnapshot {
  readonly name: string;
  readonly addedAt: number;
}
