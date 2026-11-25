const PREFIX = 'agent-editor:buffer:';

/** Every unsaved text kept in this tab's session, by path; empty when storage is unavailable. */
export function readBuffers(): Record<string, string> {
  const buffers: Record<string, string> = {};
  try {
    const storage = window.sessionStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) buffers[key.slice(PREFIX.length)] = storage.getItem(key) ?? '';
    }
  } catch {
    return {};
  }
  return buffers;
}

/** Keeps the text of a path so a reload of the tab finds it; storage may refuse, which is fine. */
export function writeBuffer(path: string, text: string): void {
  try {
    window.sessionStorage.setItem(PREFIX + path, text);
  } catch {
    // Without storage the edit lives in memory only.
  }
}

export function clearBuffer(path: string): void {
  try {
    window.sessionStorage.removeItem(PREFIX + path);
  } catch {
    // Nothing was kept.
  }
}

export function clearAllBuffers(): void {
  for (const path of Object.keys(readBuffers())) clearBuffer(path);
}
