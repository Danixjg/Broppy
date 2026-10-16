import type { ReactNode } from "react";
import { AuthShell } from "./auth-shell";

/** Where people reach whoever runs this deployment, when SUPPORT_EMAIL is set. */
export function supportEmail(): string | undefined {
  const value = process.env.SUPPORT_EMAIL?.trim();
  return value && /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/.test(value) ? value : undefined;
}

/** A plain reading page in the sign-in frame, for the privacy policy and support. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return <AuthShell>
    <article className="form-card legal">
      <h1>{title}</h1>
      <p className="form-lead">Last updated {updated}</p>
      {children}
    </article>
  </AuthShell>;
}
