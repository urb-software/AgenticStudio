export type TagRepository = {
  add(tag: string): Promise<void>;
  find: () => Promise<string[]>;
};
