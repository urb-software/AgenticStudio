export interface NoteRepository {
  add(note: string): Promise<void>;
  findOne(id: string): Promise<string | null>;
  deleteOlderThan(before: Date): Promise<number>;
}
