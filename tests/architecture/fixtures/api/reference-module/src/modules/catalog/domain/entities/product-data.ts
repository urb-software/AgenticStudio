// What the root is restored from: the plain data its repository holds. Only the entity and its
// repository adapter import this file.
export interface ProductData {
  readonly id: string;
  readonly name: string;
  readonly addedAt: number;
}
