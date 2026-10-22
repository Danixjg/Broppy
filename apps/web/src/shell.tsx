import { useEffect } from "react";
import { Activity, BookOpenText, Command, LayoutGrid, ListChecks, Search, Settings2, ShieldCheck } from "lucide-react";
import { Badge, Button } from "@heroui/react";
import { ExpandableTabs } from "@/components/expandable-tabs";

const tabs = [
  { view: "workspace", title: "Workspace", icon: LayoutGrid },
  { view: "tasks", title: "Tasks", icon: ListChecks },
  { view: "admin", title: "Admin", icon: Settings2, id: "adminTab", hidden: true },
  { view: "compliance", title: "Compliance", icon: ShieldCheck, id: "complianceTab", hidden: true },
  { view: "operations", title: "Sync health", icon: Activity },
];

export function Shell() {
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <>
      <header className="flex min-h-16 items-center gap-4 border-b border-border bg-surface px-5 text-foreground">
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-foreground" aria-hidden="true">
            <BookOpenText size={19} strokeWidth={1.8} />
          </span>
          <span className="text-base font-semibold tracking-tight">Broppy<small id="brandContext" className="block text-[0.62rem] font-normal tracking-[0.1em] text-muted">Knowledge workspace</small></span>
        </div>
        <span className="h-8 w-px bg-border" aria-hidden="true" />
        <label className="flex items-center gap-2 text-xs text-muted">
          Project
          <select id="projectSelect" className="max-w-64 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm font-semibold text-foreground" />
        </label>
        <label className="flex max-w-xl flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-muted focus-within:border-accent">
          <Search size={17} strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">Search accessible documents</span>
          <input id="search" type="search" placeholder="Search documents, threads, tasks…" autoComplete="off"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted" />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-xs text-muted" aria-hidden="true">⌘ K</kbd>
        </label>
        <Badge variant="soft" color="accent" className="environment-badge">
          <span className="live-dot" />
          <span id="workspaceMode">Loading workspace</span>
        </Badge>
        <label id="demoIdentity" className="flex items-center gap-2 text-xs text-muted">
          Viewing as
          <select id="user" className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm font-semibold text-foreground">
            <option value="ravi">Ravi</option><option value="maya">Maya</option><option value="alex">Alex</option>
            <option value="david">David</option><option value="nur">Nur</option><option value="wei">Wei Ming</option>
          </select>
        </label>
        <div id="authIdentity" className="auth-identity" hidden>
          <span id="authName" />
          <Button type="button" id="loginButton" variant="outline" size="sm" hidden>Log in</Button>
          <Button type="button" id="logoutButton" variant="outline" size="sm" hidden>Log out</Button>
        </div>
      </header>
      <nav className="view-nav flex items-center gap-3 border-b border-border bg-surface px-5 py-2" aria-label="Workspace views">
        <ExpandableTabs tabs={tabs} />
        {/* Admins' settings, always one click away from the workspace. */}
        <span id="adminLinks" className="admin-links" hidden>
          <a id="setupGuide" href="./setup.html">Setup</a>
          <a id="connectorSettings" href="./connectors.html">Connectors</a>
          <a id="peopleSettings" href="./people.html">People</a>
        </span>
        <span className="nav-context ml-auto flex items-center gap-1.5 text-[0.62rem] tracking-[0.12em] text-muted">
          <Command size={13} aria-hidden="true" /> KNOWLEDGE WORKSPACE
        </span>
        <span id="globalStatus" role="status" className="nav-status" />
      </nav>
    </>
  );
}
