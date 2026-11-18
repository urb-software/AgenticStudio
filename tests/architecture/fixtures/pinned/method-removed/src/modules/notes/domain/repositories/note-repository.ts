export interface NoteRepository {
  add(note: string): Promise<void>;
  deleteOlderThan(before: Date): Promise<number>;
}
