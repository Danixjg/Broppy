import type { ReactNode } from "react";
import "../styles.css";
export const metadata = { title: "Internal Brain · Sign in" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body className="login-page">{children}</body></html>;
}
