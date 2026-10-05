// Which project the workspace shows. "" is All sources, which a person chooses like any project.

/**
 * The project on screen if this person may still open it, else the one they chose last, else their first.
 * `current` is null before anything is shown, and `saved` is null when no choice was remembered.
 */
export function chosenProject(current, saved, keys) {
  const allowed = key => key === "" || keys.includes(key);
  if (current !== null && allowed(current)) return current;
  if (saved !== null && allowed(saved)) return saved;
  return keys[0] ?? "";
}
