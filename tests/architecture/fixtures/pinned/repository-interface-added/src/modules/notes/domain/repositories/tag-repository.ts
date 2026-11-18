export interface TagRepository {
  add(tag: string): Promise<void>;
}
