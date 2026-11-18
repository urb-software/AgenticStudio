export interface NoteRepository {
  add(note: string): Promise<void>;
  findById(id: string): Promise<string | null>;
  deleteOlderThan(before: Date): Promise<number>;
  archive(id: string): Promise<void>;
}
