import { Check, MailCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { AuthShell } from "../auth-shell";
import { authConfigured } from "../../lib/auth0";
import { needsAccessCode, signupMode, signInPath } from "../../lib/company";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create your company · Broppy" };

const MESSAGES: Record<string, string> = {
  invalid: "Check the form: add your company name, your name and a valid work email address.",
  code: "That access code isn't right. Check it and try again.",
  taken: "That company name is taken. Add a word to it and try again.",
  limit: "Too many tries just now. Please wait a little while and try again.",
  busy: "We couldn't create your company just now. Please try again in a minute."
};

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function Signup({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  if (!authConfigured || signupMode() === "off") redirect("/");
  const open = signupMode() === "on";
  const sent = one(query.sent);
  const error = MESSAGES[one(query.error)];

  if (sent) return <AuthShell>
    <section className="form-card" aria-live="polite">
      <span className="form-icon" aria-hidden="true"><MailCheck size={26} /></span>
      <h1>Check your email</h1>
      <p className="form-lead">If <strong>{sent}</strong> can start a company, an invitation is on its way. Open it, choose a password, and you will land in the guided setup.</p>
      <ul className="form-points">
        <li><Check size={16} aria-hidden="true" /><span>It can take a minute to arrive. Look in spam if you don't see it.</span></li>
        <li><Check size={16} aria-hidden="true" /><span>Already part of a company on Broppy? Sign in instead, and ask your admin to add you.</span></li>
      </ul>
      <p><a className="btn" href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;

  if (!open) return <AuthShell>
    <section className="form-card">
      <h1>Sign-ups are closed for now</h1>
      <p className="form-lead">Broppy isn't taking new companies right now. If your company is already on Broppy, sign in.</p>
      <p><a className="btn primary" href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;

  return <AuthShell>
    <section className="form-card">
      <p className="eyebrow">Step 1 of 2</p>
      <h1>Create your company</h1>
      <p className="form-lead">Tell us who you are. We email you an invitation, and the guided setup takes it from there. No cards, no code.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <form method="post" action="/api/signup" className="form">
        <label>Company name<input name="company" required maxLength={60} autoComplete="organization" defaultValue={one(query.company)} placeholder="Acme" /></label>
        <label>Your name<input name="name" required maxLength={80} autoComplete="name" defaultValue={one(query.name)} placeholder="Dana Lee" /></label>
        <label>Your work email<input name="email" type="email" required maxLength={254} autoComplete="email" defaultValue={one(query.email)} placeholder="dana@acme.com" />
          <small>You will be your company's first admin. Use the email you use for Slack, Jira or Google.</small></label>
        {needsAccessCode() && <label>Access code<input name="code" required maxLength={100} autoComplete="off" /><small>The code you were given for Broppy.</small></label>}
        <label className="trap" aria-hidden="true">Leave this empty<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <button className="btn primary" type="submit">Create my company</button>
      </form>
      <p className="form-foot">Already have a company on Broppy? <a href={signInPath()}>Sign in</a></p>
    </section>
  </AuthShell>;
}
