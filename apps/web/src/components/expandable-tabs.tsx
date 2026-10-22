import type { ComponentType } from "react";
import { Button } from "@heroui/react";

// Navigation composition adapted from Victor Welander's Expandable Tabs on 21st.dev.
// The labels stay visible on desktop and expand from icons on narrow screens.
export type WorkspaceTab = {
  view: string;
  title: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  id?: string;
  hidden?: boolean;
};

export function ExpandableTabs({ tabs }: { tabs: WorkspaceTab[] }) {
  return (
    <div className="expandable-tabs flex items-center gap-1">
      {tabs.map(({ view, title, icon: Icon, id, hidden }) => (
        <Button key={view} type="button" variant="ghost" size="sm" id={id} hidden={hidden}
          className={`nav-button expandable-tab${view === "workspace" ? " active" : ""}`}
          data-view={view} aria-label={title}>
          <Icon size={16} strokeWidth={1.8} aria-hidden={true} />
          <span className="tab-label">{title}</span>
        </Button>
      ))}
    </div>
  );
}
