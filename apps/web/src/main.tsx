import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Shell } from "./shell";
import "./theme.css";
import "../styles.css";
import "./ui.css";

const mount = document.getElementById("appShell");
if (!mount) throw new Error("Workspace shell mount is missing.");
flushSync(() => createRoot(mount).render(<Shell />));

// The existing workspace controller attaches listeners to the rendered shell IDs.
void import("../app.js");
