import type { Metadata } from "next";
import { LegalPage, supportEmail } from "../legal";

export const metadata: Metadata = { title: "Support · Broppy" };

export default function Support() {
  const email = supportEmail();
  return <LegalPage title="Support" updated="16 October 2026">
    <p>{email ? <>For help with Broppy, email <a href={`mailto:${email}`}>{email}</a>. We reply within two working days.</> : <>For help with Broppy, contact your company&apos;s Broppy admin.</>}</p>
    <h2>Common questions</h2>
    <ul>
      <li><strong>Something I expect is missing.</strong> Broppy only shows what you can open in the original tool, and only from tools your admin connected. Your admin can check Sync health.</li>
      <li><strong>A tool won&apos;t connect.</strong> Try again in a minute. If it keeps failing, your admin can disconnect and connect it again on the Connectors page.</li>
      <li><strong>Delete my data.</strong> See the <a href="/privacy">privacy policy</a>.</li>
    </ul>
  </LegalPage>;
}
