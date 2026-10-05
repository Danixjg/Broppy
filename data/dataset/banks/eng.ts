import type { Access, Bank } from "../types.js";

/** Pages for engineering leads only. */
const LEADS: Access = { groups: ["eng-leads"], restrictTo: ["eng-leads"] };

export const ENG: Bank = {
  key: "ENG",
  name: "Engineering",
  project: false,
  owners: ["platform", "sre", "mobile", "data"],
  tier: "internal",
  roles: {
    lead: ["eng-leads"], lead2: ["eng-leads"], o1: ["sre"], o2: ["sre"], e1: ["platform"], e2: ["mobile"],
    e3: ["data"], e4: ["platform"]
  },
  fileOwner: "o1",
  topics: [
    {
      id: "handbook", name: "engineering handbook",
      facts: [
        "core hours run from 10:00 to 16:00 in each office",
        "every repository has a code owners file",
        "design reviews happen before work starts on anything that takes more than two weeks",
        "engineers keep one day a month for learning"
      ],
      question: [
        "Do core hours apply on the shared office day?",
        "{lead2} answered that they do, and teams plan their meetings inside them"
      ]
    },
    {
      id: "oncall", name: "on-call",
      facts: [
        "each team runs a weekly on-call rota from Monday to Monday",
        "the on-call engineer answers a page within 15 minutes",
        "a page that lasts more than an hour goes to the team lead",
        "on-call engineers get a day off after a week with night pages"
      ],
      steps: [
        "acknowledge the page within 15 minutes",
        "post what you see in the team channel",
        "call the team lead if the problem lasts more than an hour"
      ],
      question: [
        "Can I swap an on-call week with someone on another team?",
        "{o1} answered that swaps are fine inside a team but not across teams"
      ]
    },
    {
      id: "review", name: "code review",
      facts: [
        "every pull request needs one approval from a code owner",
        "reviewers answer within one working day",
        "pull requests over 400 changed lines are split before review",
        "comments marked nit never block a merge"
      ],
      steps: [
        "read the description and the linked ticket first",
        "run the change locally if it touches more than one service",
        "approve, or ask for changes with a clear reason"
      ],
      question: [
        "Do generated files count toward the 400-line limit?",
        "{lead} answered that generated files are left out of the count"
      ]
    },
    {
      id: "search", name: "search service",
      facts: [
        "the search service answers 1,400 queries per second at peak",
        "the search index is rebuilt every night at 03:00",
        "slow queries above 800 milliseconds are logged with their plan",
        "a full index rebuild takes 95 minutes"
      ],
      question: [
        "Why did search slow down after 03:00 last night?",
        "{e1} answered that the index rebuild overran by 40 minutes and the standby index took the traffic"
      ],
      steps: [
        "find the slowest queries in the search dashboard",
        "check whether the index rebuild is still running",
        "move traffic to the standby index if latency stays above 800 milliseconds"
      ]
    },
    {
      id: "notify", name: "notification service",
      facts: [
        "the notification service sends 2.3 million messages a day",
        "push messages leave the queue within 30 seconds",
        "bounced emails are retried once and then dropped",
        "a delay above five minutes pages the platform on-call engineer"
      ],
      question: [
        "Can marketing send a big campaign on Monday morning?",
        "{e4} answered that it can if they warn us a day ahead, so the senders scale up first"
      ],
      steps: [
        "check the queue depth on the notification dashboard",
        "scale the senders if the queue grows for more than ten minutes",
        "tell support if messages are more than an hour late"
      ]
    },
    {
      id: "identity", name: "identity service",
      facts: [
        "the identity service handles sign-in for every app",
        "login errors above 2% of attempts page the identity on-call engineer",
        "the token signing key is rotated every 90 days",
        "sessions last 12 hours on the web and 30 days on mobile"
      ],
      question: [
        "When is the next signing key rotation?",
        "{o2} answered that it is due in three weeks and needs no downtime"
      ],
      steps: [
        "check the login error rate by app on the identity dashboard",
        "look for a recent deploy of the identity service",
        "roll back the deploy if errors started with it"
      ]
    },
    {
      id: "architecture", name: "architecture principles",
      facts: [
        "every service has one owning team",
        "services talk to each other through versioned APIs",
        "a new service needs an architecture review before its first deploy",
        "shared libraries have a named maintainer",
        "each service lists its owner and on-call rota in the service catalogue",
        "a service reads another service's data only through its API",
        "a replaced API stays available for one release after the new one ships"
      ],
      question: [
        "Does a small internal tool need an architecture review?",
        "{lead} answered that it does only if another team will depend on it"
      ],
      steps: [
        "write a one-page proposal with the owning team and the API",
        "book an architecture review slot",
        "add the service to the ownership map after the review"
      ],
      decision: "every service has exactly one owning team"
    },
    {
      id: "deploys", name: "deploy policy",
      facts: [
        "deploys run from 09:00 to 16:00 on working days",
        "a deploy freeze starts two days before a public holiday",
        "every deploy can be rolled back within 10 minutes",
        "exceptions to the freeze need approval from two leads"
      ],
      question: [
        "Can a fix for a broken checkout page go out during a freeze?",
        "{lead2} answered yes, with approval from two leads and someone ready to roll back"
      ],
      steps: [
        "explain the change and why it cannot wait",
        "ask two leads for approval in the deploys channel",
        "deploy with a named person ready to roll back"
      ],
      decision: "deploys stop two days before a public holiday"
    },
    {
      id: "leads", name: "engineering leadership",
      facts: [
        "engineering plans to hire 9 people over the next two halves",
        "promotion calibration happens twice a year",
        "the roadmap gives a fifth of each team's time to maintenance",
        "each lead brings two promotion cases to calibration"
      ]
    }
  ],
  pages: [
    { title: "Engineering handbook", kind: "reference", topic: "handbook", purpose: "how engineering teams work day to day" },
    { title: "Working agreements", kind: "reference", topic: "handbook", purpose: "the agreements every engineering team keeps" },
    { title: "On-call guide", kind: "howto", topic: "oncall", purpose: "handle a page during your on-call week" },
    { title: "On-call rota rules", kind: "reference", topic: "oncall", purpose: "how on-call rotas are planned and swapped" },
    { title: "Paging and escalation guide", kind: "playbook", topic: "oncall", purpose: "a page is not resolved within an hour" },
    { title: "Code review guide", kind: "howto", topic: "review", purpose: "review a pull request" },
    { title: "Pull request size guide", kind: "reference", topic: "review", purpose: "how big a pull request may be" },
    { title: "Architecture principles", kind: "reference", topic: "architecture", purpose: "the principles every service follows" },
    { title: "Service ownership map", kind: "reference", topic: "architecture", purpose: "which team owns each service" },
    { title: "Deploy policy", kind: "policy", topic: "deploys", purpose: "when and how code is deployed" },
    { title: "Deploy freeze rules", kind: "policy", topic: "deploys", purpose: "deploy freezes before public holidays" },
    { title: "Search service playbook: slow queries", kind: "playbook", topic: "search", purpose: "search latency stays above 800 milliseconds" },
    { title: "Search service playbook: index rebuild", kind: "playbook", topic: "search", purpose: "the nightly index rebuild runs late" },
    { title: "Search service overview", kind: "design", topic: "search", purpose: "how the search service indexes and answers queries" },
    { title: "Notification service playbook: delayed messages", kind: "playbook", topic: "notify", purpose: "messages wait in the queue for more than five minutes" },
    { title: "Notification service playbook: bounced emails", kind: "playbook", topic: "notify", purpose: "bounced emails rise above the usual level" },
    { title: "Notification service overview", kind: "design", topic: "notify", purpose: "how the notification service queues and sends messages" },
    { title: "Identity service playbook: login errors", kind: "playbook", topic: "identity", purpose: "login errors rise above 2% of attempts" },
    { title: "Identity service playbook: signing key rotation", kind: "playbook", topic: "identity", purpose: "the token signing key is due for rotation" },
    { title: "Identity service overview", kind: "design", topic: "identity", purpose: "how sign-in and sessions work across our apps" },
    { title: "Engineering sync: deploy freeze", kind: "meeting", topic: "deploys" },
    { title: "Engineering sync: on-call load", kind: "meeting", topic: "oncall" },
    { title: "Engineering sync: service ownership", kind: "meeting", topic: "architecture" },
    { title: "How to add a new service", kind: "howto", topic: "architecture", purpose: "add a new service" },
    { title: "How to request a deploy exception", kind: "howto", topic: "deploys", purpose: "request an exception to a deploy freeze" },
    { title: "Service health review template", kind: "reference", topic: "oncall", purpose: "what a service health review covers" },
    { title: "Tech debt register guide", kind: "reference", topic: "architecture", purpose: "how teams record and reduce tech debt" },
    { title: "Engineering headcount plan", kind: "reference", topic: "leads", purpose: "the hiring plan for engineering", access: LEADS },
    { title: "Promotion calibration guide", kind: "reference", topic: "leads", purpose: "how promotion calibration works", access: LEADS },
    { title: "Engineering roadmap priorities", kind: "reference", topic: "leads", purpose: "the priorities for the next two halves", access: LEADS }
  ],
  files: [
    { title: "Service ownership list", type: "doc", kind: "spec", topic: "architecture", status: "final", purpose: "the owning team of every service" },
    { title: "Deploy checklist", type: "doc", kind: "checklist", topic: "deploys", status: "final", purpose: "a safe deploy" },
    { title: "Architecture review template", type: "doc", kind: "guide", topic: "architecture", status: "final", purpose: "how to prepare an architecture review" },
    { title: "On-call handover template", type: "doc", kind: "checklist", topic: "oncall", status: "final", purpose: "handing over an on-call week" },
    {
      title: "On-call rota sheet", type: "sheet", topic: "oncall", status: "final",
      rows: [
        "Team platform, this week {e1}, next week {e4}",
        "Team mobile, this week {e2}, next week {lead}",
        "Team data, this week {e3}, next week {lead2}",
        "Team sre, this week {o1}, next week {o2}"
      ]
    },
    { title: "Engineering review slides", type: "slides", topic: "architecture", status: "final", purpose: "how engineering works and what changed this half" }
  ],
  channels: [
    { name: "eng-general", topics: ["handbook", "architecture"], visibility: "public" },
    { name: "eng-on-call", topics: ["oncall"], visibility: "public" },
    { name: "eng-code-review", topics: ["review"], visibility: "public" },
    { name: "eng-search-service", topics: ["search"], visibility: "public" },
    { name: "eng-notification-service", topics: ["notify"], visibility: "public" },
    { name: "eng-identity-service", topics: ["identity"], visibility: "public" },
    { name: "eng-architecture", topics: ["architecture"], visibility: "public" },
    { name: "eng-deploys", topics: ["deploys"], visibility: "public" },
    { name: "eng-tooling", topics: ["review", "deploys"], visibility: "public" }
  ]
};
