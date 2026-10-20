import { useEffect } from "react";
import { Activity, BookOpenText, Command, LayoutGrid, ListChecks, Search, Settings2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><BookOpenText size={21} strokeWidth={1.8} /></span>
          <span>Broppy<small id="brandContext">Knowledge workspace</small></span>
        </div>
        <span className="header-divider" aria-hidden="true" />
        <label className="project-switch">Project
          <select id="projectSelect" />
        </label>
        <label className="search-box">
          <Search size={17} strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">Search accessible documents</span>
          <Input id="search" type="search" placeholder="Search documents, threads, tasks…" autoComplete="off" />
          <kbd aria-hidden="true">⌘ K</kbd>
        </label>
        <Badge variant="secondary" className="environment-badge"><span className="live-dot" /><span id="workspaceMode">Loading workspace</span></Badge>
        <label id="demoIdentity" className="identity">Viewing as
          <select id="user">
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
      <nav className="view-nav" aria-label="Workspace views">
        <ExpandableTabs tabs={tabs} />
        {/* Admins' settings, always one click away from the workspace. */}
        <span id="adminLinks" className="admin-links" hidden>
          <a id="setupGuide" href="./setup.html">Setup</a>
          <a id="connectorSettings" href="./connectors.html">Connectors</a>
          <a id="peopleSettings" href="./people.html">People</a>
        </span>
        <span className="nav-context"><Command size={13} aria-hidden="true" /> KNOWLEDGE WORKSPACE</span>
        <span id="globalStatus" role="status" className="nav-status" />
      </nav>
    </>
  );
}
