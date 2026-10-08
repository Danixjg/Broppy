import { BookOpenText } from "lucide-react";
import type { ReactNode } from "react";

/** The plain frame around the sign-up and sign-in pages: the logo, one card, and a way back. */
export function AuthShell({ children }: { children: ReactNode }) {
  return <div className="site">
    <header className="nav">
      <a className="logo" href="/" aria-label="Broppy home"><span className="logo-mark" aria-hidden="true"><BookOpenText size={19} strokeWidth={1.9} /></span>Broppy</a>
    </header>
    <main className="form-page">{children}</main>
  </div>;
}
