import type { Metadata } from "next";
import { LegalPage, supportEmail } from "../legal";

export const metadata: Metadata = { title: "Privacy policy · Broppy" };

export default function Privacy() {
  const email = supportEmail();
  return <LegalPage title="Privacy policy" updated="16 October 2026">
    <p>Broppy answers your team&apos;s questions from the tools your company connects: Slack, Jira, Confluence and Google Drive. This page says what it keeps, why, and who else sees it.</p>

    <h2>What Broppy stores</h2>
    <ul>
      <li><strong>Your account:</strong> your name, email address and sign-in, held by our sign-in provider, Auth0.</li>
      <li><strong>Your company&apos;s directory:</strong> who belongs to each company, their role, and the email they use in each connected tool.</li>
      <li><strong>Content from connected tools:</strong> the messages, tickets, pages and files your admin chose to connect, with who may see each one in that tool.</li>
      <li><strong>Connection keys:</strong> the access granted when an admin connects a tool, stored encrypted and never shown again.</li>
      <li><strong>An audit trail:</strong> the questions asked, which items were used to answer, and access decisions, so admins can check what happened.</li>
    </ul>

    <h2>How it is used</h2>
    <p>Only to answer questions and show your workspace. Each person only ever sees items they can already open in the original tool; Broppy checks that with the tool before it shows or uses anything. Nothing is sold, used for advertising, or shared with other companies on Broppy.</p>

    <h2>Who else processes it</h2>
    <ul>
      <li><strong>Supabase</strong> (database, Sydney region) stores the items above.</li>
      <li><strong>Vercel</strong> hosts the website and service.</li>
      <li><strong>Auth0</strong> handles sign-in.</li>
      <li><strong>The AI model your company chose</strong> receives a question and only the passages that person may see, to write the answer.</li>
      <li><strong>Cloudflare Workers AI</strong>, when enabled, turns text into search vectors.</li>
    </ul>

    <h2>Keeping and deleting</h2>
    <p>Disconnecting a tool removes what Broppy read from it. Removing a person ends their access at once. To delete a company&apos;s data or your account, contact us below.</p>

    <h2>Contact</h2>
    <p>{email ? <>Email <a href={`mailto:${email}`}>{email}</a>.</> : <>Contact your company&apos;s Broppy admin, or see <a href="/support">support</a>.</>}</p>
  </LegalPage>;
}
