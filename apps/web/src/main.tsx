import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Shell } from "./shell";
import { PersonalWidget } from "./tasks/personal-widget";
import { TasksView } from "./tasks/tasks-view";
import "./theme.css";
import "../styles.css";
import "./ui.css";
import "./shell.css";
import "./tasks/tasks.css";

const mount = document.getElementById("appShell");
if (!mount) throw new Error("Workspace shell mount is missing.");
flushSync(() => createRoot(mount).render(<Shell />));

// The existing workspace controller attaches listeners to the rendered shell IDs.
await import("../app.js");

const tasks = document.getElementById("tasksView");
if (tasks) createRoot(tasks).render(<TasksView />);

const personal = document.getElementById("personalWidget");
if (personal) createRoot(personal).render(<PersonalWidget />);
