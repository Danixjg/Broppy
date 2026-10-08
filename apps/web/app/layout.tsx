import type { ReactNode } from "react";
import "./landing.css";

export const metadata = {
  title: "Broppy · One place to ask your whole company",
  description: "Broppy connects Slack, Jira, Confluence and Google Drive into one assistant that answers with sources, and shows each person only what they are already allowed to open."
};
export const viewport = { themeColor: "#172a3a" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
