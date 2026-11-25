// Shared by smoke-claude-model.mjs and smoke-codex-model.mjs: the model values a CLI's event
// stream (or session file) reports. NOT PART OF CI.

/** Every string value stored under a key named `model`, anywhere in `value`. */
export function modelsIn(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) modelsIn(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'model' && typeof item === 'string' && item !== '') found.add(item);
      else modelsIn(item, found);
    }
  }
  return found;
}

/** The models of one line of JSON; an unparsable line reports none. */
export function modelsOfLine(text) {
  try {
    return modelsIn(JSON.parse(text));
  } catch {
    return new Set();
  }
}
