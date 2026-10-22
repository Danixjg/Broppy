// The seams between the React tasks surface and the rest of the page. The workspace controller
// announces its own reload; the tasks surface announces its writes and asks for a task to open.

export const WORKSPACE_LOADED = "broppy:workspace-loaded";
export const TASKS_CHANGED = "broppy:tasks-changed";
export const OPEN_TASK = "broppy:open-task";
export const SHOW_ALL_TASKS = "broppy:show-all-tasks";
export const OPEN_DOC = "broppy:open-doc";

export type OpenTaskDetail = { id: string; element?: HTMLElement };
