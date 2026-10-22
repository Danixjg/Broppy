const LIMITS = { task: 200, ask: 500, doc: 200, proposal: 200, project: 64 };

export function workspaceTarget(values) {
  const params = new URLSearchParams();
  for (const [key, limit] of Object.entries(LIMITS)) {
    const value = values instanceof URLSearchParams ? values.get(key) : values[key];
    if (typeof value === "string" && value.trim() && value.length <= limit) params.set(key, value);
  }
  return `/workspace/index.html${params.size ? `?${params}` : ""}`;
}
