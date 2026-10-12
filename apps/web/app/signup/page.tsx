import { ArrowRight, Building2, Check, UserRound } from "lucide-react";
import { redirect } from "next/navigation";
import { AuthShell } from "../auth-shell";
import { authConfigured } from "../../lib/auth0";
import { signupMode, signInPath, signupPath } from "../../lib/company";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign up · Broppy" };

const choices = [
  { kind: "personal" as const, icon: UserRound, name: "Personal", button: "Sign up", line: "Try Broppy on your own.", points: [
    "A private workspace that is only yours.",
    "Connect your own Slack, Jira, Confluence and Google Drive.",
    "Nobody else can see your content. Add a team later if you like."] },
  { kind: "enterprise" as const, icon: Building2, name: "Enterprise", button: "Enterprise sign up", line: "One shared brain for your company.", points: [
    "You become the admin and connect the company's tools once.",
    "Invite your colleagues. Everyone sees only what they can already open.",
    "Admin controls, a tamper-evident audit log and your own AI choice."] }
];

export default function Signup() {
  if (!authConfigured || signupMode() === "off") redirect("/");
  const open = signupMode() === "on";
  return <AuthShell>
    <section className="choice-page">
      <h1>{open ? "How will you use Broppy?" : "Sign-ups are closed for now"}</h1>
      <p className="form-lead">{open ? "Pick the one that fits. Either way, a guided setup takes it from here." : "Broppy isn't taking new sign-ups right now. If you already have an account, sign in."}</p>
      {open && <div className="choices">
        {choices.map(({ kind, icon: Icon, name, button, line, points }) => <article key={kind} className="choice">
          <span className="form-icon" aria-hidden="true"><Icon size={24} /></span>
          <h2>{name}</h2><p className="choice-line">{line}</p>
          <ul className="form-points">{points.map(point => <li key={point}><Check size={16} aria-hidden="true" /><span>{point}</span></li>)}</ul>
          <a className={`btn${kind === "personal" ? " primary" : ""}`} href={signupPath(kind)}>{button} <ArrowRight size={17} /></a>
        </article>)}
      </div>}
      <p className="form-foot">Already have an account? <a href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;
}
