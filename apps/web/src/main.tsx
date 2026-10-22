import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Shell } from "./shell";
import { AdminView } from "./admin/admin-view";
import { ComplianceView } from "./compliance/compliance-view";
import { OperationsView } from "./operations/operations-view";
import { TasksView } from "./tasks/tasks-view";
import { WorkspaceView } from "./workspace/workspace-view";
import "./theme.css";
import "../styles.css";
import "./ui.css";
import "./shell.css";
import "./tasks/tasks.css";
import "./workspace/workspace.css";
import "./admin/admin.css";
import "./compliance/compliance.css";
import "./operations/operations.css";

const mount = document.getElementById("appShell");
if (!mount) throw new Error("Workspace shell mount is missing.");
flushSync(() => createRoot(mount).render(<Shell />));

// The existing workspace controller attaches listeners to the rendered shell IDs.
await import("../app.js");

const workspace = document.getElementById("workspaceView");
if (workspace) createRoot(workspace).render(<WorkspaceView />);

const tasks = document.getElementById("tasksView");
if (tasks) createRoot(tasks).render(<TasksView />);

const admin = document.getElementById("adminView");
if (admin) createRoot(admin).render(<AdminView />);

const compliance = document.getElementById("complianceView");
if (compliance) createRoot(compliance).render(<ComplianceView />);

const operations = document.getElementById("operationsView");
if (operations) createRoot(operations).render(<OperationsView />);
