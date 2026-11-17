// The root's current values as read-only plain data: what handlers return and repositories read.
export interface ProductSnapshot {
  readonly id: string;
  readonly name: string;
  readonly addedAt: number;
}
