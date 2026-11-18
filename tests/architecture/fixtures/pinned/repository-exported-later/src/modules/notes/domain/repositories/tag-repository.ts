interface TagRepository {
  add(tag: string): Promise<void>;
}

export { TagRepository };
