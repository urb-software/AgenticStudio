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

/** Keeps the text of a path so a reload finds it; false when storage refused and it is memory-only. */
export function writeBuffer(path: string, text: string): boolean {
  try {
    window.sessionStorage.setItem(PREFIX + path, text);
    return true;
  } catch {
    return false;
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

/** Makes the stored buffers equal `current`; false when a write was refused. */
export function syncBuffers(current: Readonly<Record<string, string>>): boolean {
  const stored = readBuffers();
  let ok = true;
  for (const [path, text] of Object.entries(current)) {
    if (stored[path] !== text && !writeBuffer(path, text)) ok = false;
  }
  for (const path of Object.keys(stored)) {
    if (!(path in current)) clearBuffer(path);
  }
  return ok;
}
