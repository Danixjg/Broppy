import { Check, MailCheck } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { AuthShell } from "../../auth-shell";
import { authConfigured } from "../../../lib/auth0";
import { needsAccessCode, signupKind, signupMode, signInPath, signupPath } from "../../../lib/company";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign up · Broppy" };

const MESSAGES: Record<string, string> = {
  invalid: "Check the form: add your name and a valid email address, and your company's name if you are signing up a company.",
  code: "That access code isn't right. Check it and try again.",
  taken: "That company name is already taken. If it's your team's, ask its admin to invite you; otherwise add a word to make it yours (for example \"Acme Singapore\").",
  limit: "Too many tries just now. Please wait a little while and try again.",
  busy: "We couldn't create your company just now. Please try again in a minute."
};

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function Signup({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const kind = signupKind((await params).kind);
  if (!kind) notFound();
  const personal = kind === "personal";
  const query = await searchParams;
  if (!authConfigured || signupMode() === "off") redirect("/");
  const open = signupMode() === "on";
  const typed = one(query.sent);
  // Only something shaped like an email is shown back, so a crafted link can't put its own wording on this page.
  const sent = typed ? (/^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,}$/.test(typed) ? typed : "the address you entered") : "";
  const error = MESSAGES[one(query.error)];

  const other = personal ? "enterprise" : "personal";
  if (sent) return <AuthShell>
    <section className="form-card" aria-live="polite">
      <span className="form-icon" aria-hidden="true"><MailCheck size={26} /></span>
      <h1>Check your email</h1>
      <p className="form-lead">If <strong>{sent}</strong> can start {personal ? "a workspace" : "a company"}, an invitation is on its way. Open it, choose a password, and you will land in the guided setup.</p>
      <ul className="form-points">
        <li><Check size={16} aria-hidden="true" /><span>It can take a minute to arrive. Look in spam if you don't see it.</span></li>
        <li><Check size={16} aria-hidden="true" /><span>{personal ? "Already have a workspace? Sign in with the same email. Part of a company on Broppy? Sign in with your company's name, and ask your admin to add you."
          : "Already part of a company on Broppy? Sign in instead, and ask your admin to add you."}</span></li>
      </ul>
      <p><a className="btn" href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;

  if (!open) return <AuthShell>
    <section className="form-card">
      <h1>Sign-ups are closed for now</h1>
      <p className="form-lead">Broppy isn't taking new sign-ups right now. If you already have a workspace or your company is on Broppy, sign in.</p>
      <p><a className="btn primary" href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;

  return <AuthShell>
    <section className="form-card">
      <p className="eyebrow">{personal ? "Sign up" : "Enterprise sign up"} · Step 1 of 2</p>
      <h1>{personal ? "Create your workspace" : "Create your company"}</h1>
      <p className="form-lead">{personal
        ? "A private workspace that is just yours. Connect your own Slack, Jira, Confluence and Google Drive and ask questions across them. We email you an invitation, and the guided setup takes it from there."
        : "One shared brain for your whole team. You become the admin, connect the company's tools once and invite your colleagues. We email you an invitation, and the guided setup takes it from there."} No cards, no code.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <form method="post" action="/api/signup" className="form">
        <input type="hidden" name="kind" value={kind} />
        {!personal && <label>Company name<input name="company" required maxLength={60} autoComplete="organization" defaultValue={one(query.company)} placeholder="Acme" /></label>}
        <label>Your name<input name="name" required maxLength={80} autoComplete="name" defaultValue={one(query.name)} placeholder="Dana Lee" /></label>
        <label>{personal ? "Your email" : "Your work email"}<input name="email" type="email" required maxLength={254} autoComplete="email" defaultValue={one(query.email)} placeholder={personal ? "dana@example.com" : "dana@acme.com"} />
          <small>{personal ? "Use the email you use for Slack, Jira or Google, so Broppy can match your accounts. You will be the only person in this workspace."
            : "You will be your company's first admin. Use the email you use for Slack, Jira or Google."}</small></label>
        {needsAccessCode() && <label>Access code<input name="code" required maxLength={100} autoComplete="off" /><small>The code you were given for Broppy.</small></label>}
        <label className="trap" aria-hidden="true">Leave this empty<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <button className="btn primary" type="submit">{personal ? "Create my workspace" : "Create my company"}</button>
      </form>
      <p className="form-foot">{personal ? "Setting this up for a company? " : "Just want to try it for yourself? "}<a href={signupPath(other)}>{personal ? "Enterprise sign up" : "Sign up"}</a> · Already have an account? <a href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;
}
