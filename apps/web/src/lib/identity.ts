// Who is looking, shared between the controller and the React surfaces. The controller writes it when the
// identity changes; a surface reads it when it mounts and follows the identity-changed event from then on.

import type { WorkspaceIdentity } from "../tasks/events";

export type Identity = WorkspaceIdentity;

const DEMO_ROLES: Record<string, Identity["role"]> = { maya: "admin", nur: "compliance" };

let current: Identity = { role: "member", mode: "loading", signedIn: false };

export const demoRole = (persona: string): Identity["role"] => DEMO_ROLES[persona] ?? "member";

export const currentIdentity = (): Identity => current;

export const setCurrentIdentity = (identity: Identity): void => {
  current = identity;
};
