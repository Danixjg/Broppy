<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

<!-- PROJECT HEADER -->
<br />
<div align="center">
  <h1>Broppy</h1>
  <p>
    One workspace for your team's knowledge. Answers and actions where you work.
    <br />
    Connect Slack, Jira, Confluence and Google Drive while respecting each person's access.
    <br />
    <br />
    <a href="https://broppy-one.vercel.app"><strong>Open Broppy »</strong></a>
    <br />
    <br />
    <a href="https://broppy-one.vercel.app/demo">Try the Demo</a>
    &middot;
    <a href="https://github.com/Danixjg/Broppy/issues/new">Report Bug</a>
    &middot;
    <a href="https://github.com/Danixjg/Broppy/issues/new">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#features">Features</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#personal-account">Personal Account</a></li>
        <li><a href="#organisation-account">Organisation Account</a></li>
        <li><a href="#joining-an-existing-organisation">Joining an Existing Organisation</a></li>
        <li><a href="#connect-your-tools">Connect Your Tools</a></li>
        <li><a href="#local-development">Local Development</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

[![Broppy project workspace][product-screenshot]](https://broppy-one.vercel.app)

*Example project workspace using the repository's fictional demo data.*

Team knowledge is scattered across conversations, tickets, documents and files. Finding an answer often means searching several tools and reconstructing the context yourself.

**Broppy brings that context together.** Ask a question across Slack, Jira, Confluence and Google Drive, inspect the sources behind the answer, and work with the related project content. In Slack, Broppy can turn a commitment into a proposed Jira ticket for you to review and approve.

Broppy was built for the **Tencent Cloud Hackathon 2026**, addressing **The Internal Brain — Building a Context-Aware Enterprise Knowledge System with RBAC, Security Logging & Audit Trail**. Its foundation is permission-aware retrieval: the content used in an answer must respect the original platform's access controls.

### Features

| Feature | What you can do |
| --- | --- |
| **Four connected sources** | Connect Slack, Jira, Confluence and Google Drive, then choose which content Broppy reads. |
| **Questions across your tools** | Ask in natural language and receive an answer grounded in connected content, with citations linking back to its sources. |
| **Project workspace** | Bring a project's Confluence pages, Jira tickets, Slack conversations and Drive files together in Broppy. |
| **Confluence editing** | Read and edit Confluence content from Broppy, or open the original page in Confluence. |
| **Slack bot** | Ask questions privately with `/broppy` or the **Ask Broppy** message shortcut. |
| **Slack-to-Jira actions** | Detect commitments in conversations, review a proposed ticket, edit its draft and approve its creation in Jira. |
| **Catch-up** | Get a catch-up view based on your role, groups and project access. |
| **Latest versions and duplicates** | Inspect why a document is considered the latest and preview likely duplicates. A merge preview does not itself merge content. |
| **Permission-aware answers** | Filter source content before it reaches the answer writer, and recheck source access when answering, including changes to a person's permissions. |
| **Audit and compliance** | Search recorded activity, inspect questions, answers and access decisions, export CSV and verify tamper-evident audit proofs. |
| **People and access** | Invite colleagues, assign Broppy roles, match their source accounts and remove workspace access. |
| **AI model choice** | Use the default assistant or connect your workspace's own supported AI provider account. |

The five [Worked Examples](apps/api/src/__snapshots__/worked-examples.md) walk through the hackathon scenarios with fictional data; `pnpm test` keeps them in step with the code.

### Built With

| Technology | Role |
| --- | --- |
| [Next.js](https://nextjs.org/), [React](https://react.dev/) and [Tailwind CSS](https://tailwindcss.com/) | Web application and interface. |
| [TypeScript](https://www.typescriptlang.org/) and [Node.js](https://nodejs.org/) | API, service adapters and Slack integration. |
| [Rust](https://www.rust-lang.org/) | Domain core, exposed to the Node application through a native module. |
| [Supabase](https://supabase.com/) | PostgreSQL persistence, pgvector search and Vault-backed credentials. |
| [Auth0](https://auth0.com/) | Sign-in, organisations and invitations. |
| [Vercel](https://vercel.com/) | Web and serverless deployment. |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

Broppy is live at **[broppy-one.vercel.app](https://broppy-one.vercel.app)**. Both personal and organisation signups are open.

### Prerequisites

To use the hosted application, you need:

- An email address you can receive invitations at. Use the email associated with your connected tools where possible.
- Access to at least one supported source: Slack, Jira, Confluence or Google Drive. You can add more sources later.
- Permission to approve each connection. Adding Broppy to Slack requires permission to install workspace apps or approval from your Slack administrator.

Your organisation's admin connects its tools and invites colleagues. Each colleague signs in with their own Broppy account; their answers remain limited by their source permissions.

### Installation

Open [Broppy](https://broppy-one.vercel.app) in your browser and choose the account that fits your use:

| Account | Choose this when | Signup button |
| --- | --- | --- |
| **Personal** | You want a workspace for yourself. You are its only member and admin. | **Sign up** |
| **Organisation** | You are setting up a shared workspace and will invite your team. You become its first admin. | **Enterprise sign up** |
| **Invited member** | Your organisation already uses Broppy. | Accept your admin's email invitation, then **Sign in**. |

No local installation is needed for the hosted application.

### Personal Account

1. Open [Broppy](https://broppy-one.vercel.app) and select **Sign up**.
2. Enter your name and email, then select **Create my workspace**.
3. Open the invitation sent to your email. Follow the link to choose a password and complete sign-in, including email verification if requested.
4. Follow the guided setup to **Connect your tools** and **Choose what Broppy reads**, as described below.
5. At **Pick your AI**, keep the default assistant or connect your own supported AI account. This step is optional.
6. Select **Open my workspace** and ask your first question.

A personal workspace has no team invitation step. For a shared team workspace, use **Enterprise sign up**.

### Organisation Account

1. Open [Broppy](https://broppy-one.vercel.app) and select **Enterprise sign up**.
2. Enter your company name, your name and your work email, then select **Create my company**.
3. Accept the invitation sent to your work email and complete sign-in. You become the organisation's first admin.
4. In guided setup, **Connect your tools** and **Choose what Broppy reads**.
5. Under **Add your team**, paste colleagues' work emails, one per line or separated by commas. Choose their role and select **Send invitations**. You can skip this step and invite people later from **People and access**.
6. Under **Pick your AI**, keep the default assistant or connect the organisation's own supported AI account.
7. Open the workspace. Your colleagues join by accepting their own invitations.

| Broppy role | Purpose |
| --- | --- |
| **Member** | Ask questions and use the workspace within their source access. |
| **Admin** | Manage connections, content scope and the people who can use Broppy. |
| **Compliance** | Review recorded activity through the audit tools. |

Broppy roles do not grant access to restricted source content. Manage those permissions in Slack, Jira, Confluence or Google Drive.

### Joining an Existing Organisation

1. Ask your Broppy admin to add your work email under **People and access**.
2. Open the invitation and sign in with that email. Complete email verification if prompted.
3. Open the workspace and ask a question. Your admin has already connected the organisation's tools.
4. On later visits, select **Sign in** and use your email and password. If you belong to multiple organisations, choose the relevant one when prompted.

If an invitation has expired, ask your admin to resend it. If you already have an account, sign in rather than creating another workspace.

### Connect Your Tools

These steps apply to personal workspace owners and organisation admins. Return to **Guided setup** or **Connectors** to change them later.

1. Under **Connect your tools**, select **Add to Slack** or **Connect** beside the tool you want.
2. Sign in on the provider's own approval page, review the requested access and approve the connection. Broppy returns you to setup.
3. Repeat for your other tools. An Atlassian approval can connect both Jira and Confluence when both products' permissions are granted.
4. Under **Choose what Broppy reads**, save a scope for each connected source:

   | Source | Content to select |
   | --- | --- |
   | Slack | Channels. |
   | Jira | Projects. |
   | Confluence | Spaces. |
   | Google Drive | Shared drives; My Drive selection uses file IDs. |

   Choose **Include everything**, **Include only what I select** or **Include nothing**. The choice is limited to what the connected account can access. On **Connectors**, you can also limit history by date or include only content new or changed from now on.

5. Wait for the initial import. Check connection status and progress in **Connectors**, and inspect **Sync health** if a source needs attention.
6. For Slack, invite the bot to the channels where you want to use it:

   ```text
   /invite @Broppy
   ```

Connecting a tool and choosing its scope determines what enters the workspace. Each person's source permissions still determine what they can see in answers.

**Match your source accounts.** Broppy uses directory email addresses to identify people in connected tools. If a colleague uses another email for a source, the admin can update it under **People and access → Source accounts**, use **Check** to inspect the mapping and **Refresh access** to read source permissions again. Slack bot users must also be matched to their Broppy identities.

**Choose an AI model (optional).** In **Pick your AI** or **Connectors → AI model**, choose a supported provider, enter its model name and API key, and select **Connect and test** or **Save and test**. The key is stored encrypted and is not shown again. Newly signed-up workspaces support Anthropic and OpenAI; custom OpenAI-compatible endpoints are restricted.

**If setup needs attention:** check spam for invitation emails, use the email your admin invited, reconnect expired tool authorisations and check that the chosen scope includes the content you need. If a tool account cannot be matched, ask your admin to check **Source accounts**. Setup resumes when you return.

### Local Development

For developers running the repository, use Node.js 22, **pnpm 9.15.0** and [Rust through rustup](https://rust-lang.org/tools/install/). The repository pins its Rust toolchain.

```sh
git clone https://github.com/Danixjg/Broppy.git
cd Broppy
pnpm install
pnpm rust:build
```

**Run with fictional demo data.** Start the API in one terminal:

```sh
pnpm dev
```

Start the web application in a second terminal. The following environment-variable syntax is for Bash:

```sh
DEMO_API_URL=http://127.0.0.1:3000 pnpm --dir apps/web dev
```

Open **http://127.0.0.1:3001**, choose **Try the demo** and switch between fictional users with **Viewing as**. Demo changes reset when the in-memory API restarts.

**Run with sign-in and real sources.** Copy `.env.example` to `.env.local` at the repository root, then configure Auth0, Supabase and source OAuth using the guides below. Run the API and web application in separate terminals:

```sh
# Terminal 1
pnpm dev:sso
```

```sh
# Terminal 2
pnpm --dir apps/web dev
```

Open **http://127.0.0.1:3001**. Use `pnpm doctor:sso` to diagnose sign-in configuration. The `pnpm dev` command runs the demo API; `pnpm dev:sso` loads `.env.local` for the authenticated API.

| Setup guide | Covers |
| --- | --- |
| [Auth0 setup and troubleshooting](apps/web/AUTH0.md) | Local sign-in, sessions and required environment variables. |
| [Slack app](apps/slack/README.md) | App installation, Jira destinations and task approval configuration. |

Keep `.env.local` and provider secrets out of commits.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

### Ask Across Your Tools

Open the workspace, select a project or **All sources**, then ask a question such as:

> What's the status of the database migration, and what blockers were raised in Slack last week?

Broppy retrieves relevant content you may access and returns an answer with numbered citations. Select a citation to inspect its source and highlighted passage. Use the source's **Open in Slack**, **Open in Jira**, **Open in Confluence** or **Open in Drive** link to visit the original.

Answers depend on the content and permissions in your connected tools. The question above is also demonstrated with fictional data in the [Worked Examples](apps/api/src/__snapshots__/worked-examples.md).

### Work With Project Content

Select a project to view its related Confluence documentation, Jira tasks, Slack threads and Drive files. Open Confluence content to read or edit it within Broppy, or follow the link to the original page. Use the catch-up view for context relevant to your role and access, and **Why latest?** to inspect document freshness. Duplicate previews let you compare likely overlaps before deciding what to do.

### Ask Broppy in Slack

In a channel where Broppy has been added, enter:

```text
/broppy What changed in the migration project this week?
```

You can also choose **Ask Broppy** from a message's shortcuts. Answers are returned privately and use the asking person's Broppy identity and source access.

### Turn a Slack Commitment Into a Jira Ticket

1. Have a conversation containing an actionable commitment. For example:

   > I'll update the migration runbook by Friday.

2. Broppy can detect the commitment and privately propose a Jira task. You can also use the **Track with Broppy** message shortcut.
3. Review the proposed summary, owner, date, project and the fields that will be sent. Edit the draft, dismiss it or approve ticket creation. Where a suitable existing issue is suggested, explicitly choose to link it instead.
4. After approval, Broppy creates the Jira ticket and records the action. A thread notification is sent when the configured audience checks allow it.

**You approve before Jira creation.** Using this workflow requires a connected Jira account and a configured destination for the Slack channel and Jira project. Workspace operators configure the destination and disclosure policy; see [Slack app setup](apps/slack/README.md). The approval flow is a live Broppy feature.

### Review Activity and Access

Compliance users can search the audit console by person, source and date, inspect recorded questions, answers and authorisation decisions, export CSV and verify sealed audit proofs. Admins manage membership through **People and access**; removing a person disables their Broppy access. Changes to access in the source tools are checked again when Broppy answers.

For example, a compliance user can ask:

> Show me everything user 'ravi' accessed related to the 'payment-gateway' Confluence space in the last 30 days.

Choose **Search the audit log** to run the audit inquiry. Replace the example user and space with those in your workspace.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [ ] **Multi-agent workflow:** describe a task in the project chat and have agents help carry it out.
- [ ] **AI summaries.**
- [ ] **Automated event triggers:** respond to emergency calls.

These are planned additions. See [open issues](https://github.com/Danixjg/Broppy/issues) to discuss improvements and report problems.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Report bugs and suggest improvements through [GitHub Issues](https://github.com/Danixjg/Broppy/issues). To propose a code change:

1. Fork the repository.
2. Create a branch: `git checkout -b feature/your-feature`.
3. Make the change and run the relevant checks:

   ```sh
   pnpm typecheck
   pnpm test
   ```

4. Commit and push to your fork.
5. Open a pull request explaining the change and how you verified it.

For changes to permissions, retrieval or external actions, include the allowed and denied cases in your verification.

[View contributors](https://github.com/Danixjg/Broppy/graphs/contributors).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

No project licence has been specified in this repository.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

For questions, bug reports or feature requests, open an issue in [Danixjg/Broppy](https://github.com/Danixjg/Broppy/issues).

Project: [github.com/Danixjg/Broppy](https://github.com/Danixjg/Broppy)  
Website: [broppy-one.vercel.app](https://broppy-one.vercel.app)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

- **Tencent Cloud Hackathon 2026** — the Internal Brain challenge that Broppy was built to address.
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template) — the structure used for this README.
- [Shields.io](https://shields.io/) — repository badges.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/Danixjg/Broppy.svg?style=for-the-badge
[contributors-url]: https://github.com/Danixjg/Broppy/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/Danixjg/Broppy.svg?style=for-the-badge
[forks-url]: https://github.com/Danixjg/Broppy/forks
[stars-shield]: https://img.shields.io/github/stars/Danixjg/Broppy.svg?style=for-the-badge
[stars-url]: https://github.com/Danixjg/Broppy/stargazers
[issues-shield]: https://img.shields.io/github/issues/Danixjg/Broppy.svg?style=for-the-badge
[issues-url]: https://github.com/Danixjg/Broppy/issues
[product-screenshot]: .github/assets/workspace-project.png
