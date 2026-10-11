import { ArrowRight, BadgeCheck, BookOpenText, Check, EyeOff, HardDrive, KeyRound, ListChecks, Lock, MessageSquare, Plug, ScrollText, Search, Sparkles, Ticket, Users } from "lucide-react";
import { auth0, authConfigured } from "../lib/auth0";
import { signInPath, signupMode, signupPath } from "../lib/company";
import { demoApiUrl } from "../lib/demo";
import { workspaceTarget } from "../links";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const SETUP_PAGE = "/workspace/setup.html";
const login = (returnTo: string) => signInPath(returnTo);

const steps = [
  { icon: Plug, title: "Connect your tools", text: "Approve access to Slack, Jira, Confluence and Google Drive with a few clicks. You sign in on each tool's own page, so Broppy never sees your passwords." },
  { icon: Users, title: "Add your team", text: "Type in your colleagues' work emails. Each person gets an invitation and signs in with their own work account." },
  { icon: Search, title: "Ask anything", text: "Ask a question in plain English. Broppy answers from your real conversations, tickets and documents, and links to every source it used." }
];

const pillars = [
  { name: "Seamless", line: "It works where your knowledge already lives.", points: [
    "Nothing to move or copy. Broppy keeps up with your tools on its own.",
    "Turn a conversation into a Jira ticket. You review it, then confirm.",
    "Ask from the web, or straight from Slack."] },
  { name: "Simple", line: "Set up in your browser, start to finish.", points: [
    "A guided setup walks you through every step. No code, no settings files.",
    "Answers are short and plain, each with the sources behind it.",
    "Your admin decides who is in. An account alone is never enough."] },
  { name: "Secure", line: "People only see what they can already open.", points: [
    "Every answer checks the original tool again. If someone loses access in Slack or Jira, it leaves their answers straight away.",
    "Every question and answer is written to a tamper-evident log your compliance team can review.",
    "Connections are stored encrypted, and you choose which AI model Broppy uses."] }
];

const trust = [
  { icon: EyeOff, title: "Nobody sees more than they should", text: "Broppy mirrors the permissions you already set in Slack, Jira, Confluence and Google Drive. When it can't tell, it says no." },
  { icon: Lock, title: "Your passwords stay with your tools", text: "You approve access on Slack's, Atlassian's and Google's own pages. Broppy is given a limited key, never your password." },
  { icon: ScrollText, title: "A record of everything", text: "Every question, answer and change is logged in a way that can't be quietly rewritten, for the people who need to check." },
  { icon: KeyRound, title: "You choose the AI", text: "Use Broppy's built-in assistant, or connect your company's own AI account. Only the passages a person may see are ever sent." },
  { icon: Users, title: "You control who is in", text: "Only the work emails your admin adds can sign in. Removing someone ends their access at once." },
  { icon: BadgeCheck, title: "Answers you can check", text: "Each answer links to the message, ticket or page it came from, and lines that can't be backed by a source are left out." }
];

const questions = [
  ["Do I need a technical person to set this up?", "No. After you sign in, a guided setup takes you through connecting your tools, choosing what Broppy reads, adding your team and, if you like, picking an AI. Everything is buttons and forms."],
  ["What does Broppy read?", "Only what you choose. For each tool you can include everything it can see, only the channels, projects or folders you pick, or nothing yet. You can change this any time."],
  ["Can people see things they shouldn't?", "No. Broppy follows each tool's own permissions and checks them again for every answer. A private Slack channel stays private, and a restricted Jira project stays restricted."],
  ["What happens when someone leaves?", "Your admin removes their email and their access to Broppy ends immediately. If they also lose access in a tool, that tool's content leaves their answers right away."],
  ["Which AI answers the questions?", "By default, Broppy's built-in assistant writes answers from your sources. You can instead connect your company's own AI account in setup. It is optional."],
  ["How do I get an account?", "Your Broppy admin adds your work email, and you sign in with it. If you can't sign in, ask your admin to check that your email is on the list."]
] as const;

const startQuestions = [
  ["How do I start with my own company?", "Press Enterprise sign up, enter your company's name, your name and your work email, and open the invitation we send you. You become your company's first admin, and the guided setup begins straight away."],
  ["Can I use Broppy just for myself?", "Yes. Press Sign up, enter your name and email, and open the invitation we send you. You get a private workspace where you are the only person: connect your own Slack, Jira, Confluence and Google Drive and ask across them. Nobody else can see it. If your team wants to share one brain, an Enterprise sign up lets the admin connect the tools once for everyone."]
] as const;

function Product() {
  return <div className="product" aria-label="An example question and answer in Broppy" role="img">
    <span className="product-tag" aria-hidden="true">Example</span>
    <div className="product-sources" aria-hidden="true">
      <span><MessageSquare size={14} /> Slack</span><span><ListChecks size={14} /> Jira</span>
      <span><BookOpenText size={14} /> Confluence</span><span><HardDrive size={14} /> Drive</span>
    </div>
    <div className="product-body" aria-hidden="true">
      <p className="bubble ask">Why did the payments cutover slip, and who owns the next step?</p>
      <div className="bubble answer">
        <p><Sparkles size={14} /> The cutover moved a week because the bank sandbox approval was late. Maya owns the next step: confirming the new date with the bank.</p>
        <div className="cites"><span>#payments thread</span><span>PAY-101</span><span>Cutover plan</span></div>
      </div>
      <p className="product-lock"><Lock size={13} /> Shown only because you can open all three sources</p>
    </div>
  </div>;
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const target = workspaceTarget(await searchParams);
  const demo = Boolean(demoApiUrl());
  const mode = signupMode();
  const session = authConfigured ? await auth0.getSession() : null;
  if (session && target.includes("?")) redirect(target);
  const demoLink = `/demo${target.includes("?") ? target.slice(target.indexOf("?")) : ""}`;

  const primary = session ? <a className="btn primary" href={target}>Open your workspace <ArrowRight size={17} /></a>
    : authConfigured && mode === "on" ? <a className="btn primary" href={signupPath("personal")}>Sign up <ArrowRight size={17} /></a>
      : authConfigured ? <a className="btn primary" href={login(SETUP_PAGE)}>{mode === "closed" ? "Sign in" : "Get started"} <ArrowRight size={17} /></a> : null;
  const secondary = session ? <a className="btn" href={SETUP_PAGE}>Continue setup</a>
    : authConfigured && mode === "on" ? <a className="btn" href={signupPath("enterprise")}>Enterprise sign up</a>
      : demo ? <a className="btn" href={demoLink}>Try the demo</a> : null;

  return <div className="site">
    <a className="skip" href="#main">Skip to content</a>
    <header className="nav">
      <a className="logo" href="/" aria-label="Broppy home"><span className="logo-mark" aria-hidden="true"><BookOpenText size={19} strokeWidth={1.9} /></span>Broppy</a>
      <nav aria-label="Page sections"><a href="#how">How it works</a><a href="#why">Why Broppy</a><a href="#security">Security</a><a href="#faq">Questions</a></nav>
      <div className="nav-actions">
        {session ? <><a className="link" href="/auth/logout">Sign out</a><a className="btn small primary" href={target}>Open workspace</a></>
          : authConfigured ? <><a className="link" href={login(target)}>Sign in</a>{mode === "on" ? <><a className="btn small" href={signupPath("enterprise")}>Enterprise sign up</a><a className="btn small primary" href={signupPath("personal")}>Sign up</a></>
            : mode !== "closed" && <a className="btn small primary" href={login(SETUP_PAGE)}>Get started</a>}</>
            : demo ? <a className="btn small primary" href={demoLink}>Try the demo</a> : null}
      </div>
    </header>

    <main id="main">
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">One brain for your whole company</p>
          <h1>Every answer your team needs, from every tool they already use.</h1>
          <p className="lead">Broppy connects Slack, Jira, Confluence and Google Drive into one place you can simply ask. Every answer shows where it came from, and everyone sees only what they are already allowed to open.</p>
          <div className="cta-row">{primary}{secondary}</div>
          {!authConfigured && !demo && <p className="notice" role="status">Sign-in isn't set up on this site yet. Ask whoever runs Broppy for your company to finish setting it up.</p>}
          <p className="reassure"><Check size={15} /> No technical skills needed <Check size={15} /> Guided setup <Check size={15} /> You stay in control</p>
        </div>
        <Product />
      </section>

      <section id="how" className="band">
        <div className="section-head"><p className="eyebrow">How it works</p><h2>From separate tools to one place to ask, in three steps</h2></div>
        <ol className="steps">
          {steps.map(({ icon: Icon, title, text }, index) => <li key={title}>
            <span className="step-icon" aria-hidden="true"><Icon size={22} /></span>
            <span className="step-number">Step {index + 1}</span><h3>{title}</h3><p>{text}</p>
          </li>)}
        </ol>
      </section>

      <section id="why" className="band alt">
        <div className="section-head"><p className="eyebrow">Built on three ideas</p><h2>Seamless. Simple. Secure.</h2></div>
        <div className="pillars">
          {pillars.map(pillar => <article key={pillar.name}>
            <h3>{pillar.name}</h3><p className="pillar-line">{pillar.line}</p>
            <ul>{pillar.points.map(point => <li key={point}><Check size={16} aria-hidden="true" /><span>{point}</span></li>)}</ul>
          </article>)}
        </div>
      </section>

      <section className="band">
        <div className="section-head"><p className="eyebrow">What setup looks like</p><h2>Everything happens in your browser</h2><p className="sub">After you sign in, a guided page takes you through each part and shows what is done and what is next.</p></div>
        <ol className="setup-list">
          <li><span>1</span><div><strong>Connect your tools</strong><p>Press Connect next to Slack, Jira, Confluence or Google Drive and approve access on their page. You land back where you left off.</p></div></li>
          <li><span>2</span><div><strong>Choose what Broppy reads</strong><p>Everything each tool can see, only the parts you pick, or nothing yet. Watch it read your content and see the progress.</p></div></li>
          <li><span>3</span><div><strong>Add your team</strong><p>Paste in work emails. Broppy invites each person and tells you if any of their tool accounts can't be found.</p></div></li>
          <li><span>4</span><div><strong>Pick your AI (optional)</strong><p>Keep Broppy's built-in assistant, or connect your company's own AI account. You can change this later.</p></div></li>
        </ol>
        <div className="cta-row center">{primary}</div>
      </section>

      <section id="security" className="band alt">
        <div className="section-head"><p className="eyebrow">Security you can explain to your team</p><h2>Built so the right people see the right things</h2></div>
        <div className="trust">
          {trust.map(({ icon: Icon, title, text }) => <article key={title}><span className="trust-icon" aria-hidden="true"><Icon size={20} /></span><h3>{title}</h3><p>{text}</p></article>)}
        </div>
      </section>

      <section id="faq" className="band">
        <div className="section-head"><p className="eyebrow">Questions</p><h2>Before you start</h2></div>
        <div className="faq">
          {(mode === "on" ? [...startQuestions, ...questions] : questions).map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}
        </div>
      </section>

      <section className="final">
        <Ticket size={26} aria-hidden="true" />
        <h2>Bring your company's knowledge into one place.</h2>
        <p>Sign in, follow the guided setup, and ask your first question.</p>
        <div className="cta-row center">{primary}{secondary}</div>
      </section>
    </main>

    <footer className="foot"><span>Broppy</span><span>
      {session ? <a href="/auth/logout">Sign out</a> : authConfigured ? <a href={login(target)}>Sign in</a> : null}
      {demo && !session && <a href={demoLink}>Try the demo</a>}
      <a href="#main">Back to top</a></span></footer>
  </div>;
}
