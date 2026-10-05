import type { Access, Bank } from "../types.js";

/** Audit evidence: restricted to the risk team. */
const AUDIT: Access = { groups: ["risk"], restrictTo: ["risk"], tier: "restricted" };

export const KYC: Bank = {
  key: "KYC",
  name: "KYC review automation",
  project: true,
  owners: ["risk", "product"],
  tier: "internal",
  roles: { lead: ["risk", "legal"], pm: ["product"], r1: ["risk"], r2: ["risk"], r3: ["risk"], p2: ["product"] },
  fileOwner: "lead",
  goal: "analysts clear the review queue within one working day, with every decision backed by audit evidence",
  status: [
    "the review queue holds 340 cases, down from 1,200",
    "automatic checks clear 58% of cases without an analyst",
    "the median handling time is 14 minutes, down from 31"
  ],
  topics: [
    {
      id: "queue", name: "review queue",
      facts: [
        "the review queue holds 340 cases, down from 1,200",
        "cases older than one working day are flagged in red",
        "analysts pick cases in order of risk score",
        "the queue is staffed from 08:00 to 20:00 on weekdays"
      ],
      steps: [
        "move two analysts from alert tuning to the queue",
        "pause sample reviews until the queue drops under 400 cases",
        "post the queue size in the review queue channel every two hours"
      ],
      question: [
        "Can we stop weekend cover once automation clears half the queue?",
        "{lead} answered that one analyst stays on call at weekends until the backlog stays under 400"
      ],
      decision: "cases are picked in order of risk score, not arrival time"
    },
    {
      id: "alerts", name: "alert tuning",
      facts: [
        "false positives fell from 71% to 44% of alerts",
        "name matching ignores accents and word order",
        "each tuning change is replayed on the previous month's alerts before it goes live",
        "the tuning board will meet every second Wednesday"
      ],
      steps: [
        "turn the tuning change off in the rules console",
        "replay the previous month's alerts without it",
        "reopen any case the change closed while it was live"
      ],
      risk: "a looser name match could miss a true hit, so every change is replayed first",
      decision: "every tuning change is replayed on past alerts before it goes live"
    },
    {
      id: "automation", name: "automatic checks",
      facts: [
        "automatic checks clear 58% of cases without an analyst",
        "document checks read the expiry date and the issuing country",
        "a case with any failed check goes to an analyst",
        "every automatic decision is logged with the inputs it used",
        "automatic checks run within two minutes of a case arriving",
        "the address check compares the document with the application form",
        "a document photo that is too dark fails the document check"
      ]
    },
    {
      id: "evidence", name: "audit evidence",
      facts: [
        "every closed case keeps its evidence for seven years",
        "auditors sample 50 closed cases every three months",
        "each evidence record links the case, the analyst and the rule version",
        "the evidence index lists 18 thousand closed cases",
        "evidence records cannot be edited once a case closes",
        "the last audit sample found two cases with a missing screenshot"
      ],
      decision: "auditors sample 50 closed cases every three months"
    },
    {
      id: "handling", name: "handling time",
      facts: [
        "the median handling time is 14 minutes, down from 31",
        "pre-filled case summaries save about 9 minutes per case",
        "complex cases still take over an hour",
        "handling time is not yet tracked for each case type"
      ]
    },
    {
      id: "escalation", name: "escalation rules",
      facts: [
        "cases scoring above 80 go to a senior analyst",
        "an escalated case needs a second reviewer before it closes",
        "escalations dropped by 20% after the scoring change"
      ],
      steps: [
        "check the case score and the failed checks",
        "assign the case to the senior analyst on shift",
        "add a second reviewer before you close the case"
      ]
    },
    {
      id: "scoring", name: "risk scoring",
      facts: [
        "the risk score combines country, product and account age",
        "score thresholds are set by the risk committee",
        "a replay showed scores change for less than 10% of cases"
      ],
      question: [
        "Who changes the score thresholds?",
        "{r2} answered that only the risk committee changes them"
      ]
    },
    {
      id: "training", name: "analyst training",
      facts: [
        "new analysts shadow a senior analyst for two weeks",
        "the training guide covers the 12 most common case types",
        "each new analyst reviews 10 sample cases before going live",
        "the first training week covers the review queue and the case types",
        "in the second week each new analyst works live cases with a senior analyst",
        "trainees pass a short quiz before they work alone"
      ]
    }
  ],
  issues: [
    { topic: "automation", summary: "Clear simple cases automatically", what: "clears cases where every automatic check passes", acceptance: "at least 55% of cases close without an analyst for two weeks", status: "done" },
    { topic: "alerts", summary: "Replay tuning changes on past alerts", what: "replays each tuning change on the previous month's alerts before it goes live", acceptance: "every tuning change shows its replay result", status: "done" },
    { topic: "alerts", summary: "Ignore accents in name matching", what: "makes name matching ignore accents and word order", acceptance: "false positives drop below 50% of alerts", status: "done" },
    { topic: "queue", summary: "Order the queue by risk score", what: "orders the review queue by risk score instead of arrival time", acceptance: "the highest scoring case is always at the top", status: "done" },
    { topic: "queue", summary: "Flag cases older than one working day", what: "flags cases older than one working day in red", acceptance: "the queue view shows every overdue case in red", status: "done" },
    { topic: "handling", summary: "Pre-fill case summaries", what: "pre-fills each case summary from the automatic checks", acceptance: "median handling time drops below 15 minutes", status: "in review" },
    { topic: "escalation", summary: "Route high scores to senior analysts", what: "routes cases scoring above 80 to a senior analyst", acceptance: "no case above 80 is closed by a junior analyst", status: "done" },
    { topic: "escalation", summary: "Require a second reviewer for escalations", what: "requires a second reviewer before an escalated case closes", acceptance: "every escalated case shows two reviewers", status: "in progress" },
    { topic: "evidence", summary: "Keep evidence with each closed case", what: "keeps the evidence of each closed case for seven years", acceptance: "auditors find the evidence for any sampled case", status: "done", access: AUDIT },
    { topic: "evidence", summary: "Build the audit evidence index", what: "builds an index of evidence by case, analyst and rule version", acceptance: "the index finds any case in under 10 seconds", status: "in progress", access: AUDIT },
    { topic: "automation", summary: "Read document expiry dates", what: "reads the expiry date and issuing country from identity documents", acceptance: "expired documents are never cleared automatically", status: "done" },
    { topic: "scoring", summary: "Add account age to the risk score", what: "adds account age to the risk score", acceptance: "scores change for less than 10% of cases in a replay", status: "in review" },
    { topic: "training", summary: "Write the analyst training guide", what: "writes the training guide for the 12 most common case types", acceptance: "two new analysts finish training with it", status: "in progress" },
    { topic: "handling", summary: "Measure handling time per case type", what: "measures handling time for each case type", acceptance: "the dashboard shows handling time by case type", status: "in progress" },
    { topic: "automation", summary: "Log every automatic decision", what: "logs every automatic decision with the inputs it used", acceptance: "an auditor can rebuild any decision from the log", status: "done" },
    { topic: "alerts", summary: "Hold a tuning board every second Wednesday", what: "sets up a tuning board that meets every second Wednesday", acceptance: "each tuning change has a board decision", status: "open" },
    { topic: "queue", summary: "Staff the queue from 08:00 to 20:00", what: "sets queue staffing from 08:00 to 20:00 on weekdays", acceptance: "no case waits more than an hour during staffed hours", status: "done" },
    { topic: "scoring", summary: "Review score thresholds with the risk committee", what: "reviews score thresholds with the risk committee", acceptance: "the committee signs off the thresholds", status: "blocked", blockedBy: "waits on the risk committee's next meeting" },
    { topic: "training", summary: "Add sample cases to training", what: "adds 10 sample cases for each new analyst", acceptance: "every new analyst reviews 10 samples before going live", status: "open" },
    { topic: "escalation", summary: "Track escalation rates", what: "tracks the share of cases that escalate each week", acceptance: "the weekly view shows escalation rates by team", status: "open" },
    { topic: "automation", summary: "Send failed checks to an analyst", what: "sends any case with a failed check to an analyst", acceptance: "no case with a failed check closes automatically", status: "done" },
    { topic: "queue", summary: "Plan weekend cover", what: "plans weekend cover with one analyst on call", acceptance: "the backlog stays under 400 cases on Monday mornings", status: "blocked", blockedBy: "waits on approval for weekend allowances" }
  ],
  masterIssues: [1, 2, 6, 18],
  pages: [
    { title: "Review queue design", kind: "design", topic: "queue", purpose: "how cases enter, wait in and leave the review queue" },
    { title: "Decision record: queue order by risk score", kind: "decision", topic: "queue" },
    { title: "Decision record: replay before tuning", kind: "decision", topic: "alerts" },
    { title: "Playbook: queue backlog over 500", kind: "playbook", topic: "queue", purpose: "the review queue grows past 500 cases" },
    { title: "Playbook: undoing a tuning change", kind: "playbook", topic: "alerts", purpose: "a tuning change closes cases it should not" },
    { title: "Tuning board summary: name matching", kind: "meeting", topic: "alerts" },
    { title: "Tuning board summary: thresholds", kind: "meeting", topic: "scoring" },
    { title: "How to escalate a case", kind: "howto", topic: "escalation", purpose: "escalate a case to a senior analyst" },
    { title: "Analyst training guide", kind: "reference", topic: "training", status: "draft", purpose: "what a new analyst learns in the first two weeks" },
    { title: "Audit evidence index", kind: "reference", topic: "evidence", purpose: "where the evidence for each closed case is kept", access: AUDIT },
    { title: "Audit sampling method", kind: "decision", topic: "evidence", access: AUDIT },
    { title: "Audit findings log", kind: "meeting", topic: "evidence", access: AUDIT }
  ],
  files: [
    { title: "Automation rollout plan", type: "doc", kind: "plan", topic: "automation", status: "final", master: true, purpose: "the automatic checks and when each one went live", say: ["Automatic checks clear 58% of cases, and the queue is down to 340 cases."] },
    { title: "Escalation guide", type: "doc", kind: "guide", topic: "escalation", status: "final", purpose: "how an analyst escalates a case" },
    { title: "Alert tuning proposal", type: "doc", kind: "proposal", topic: "alerts", status: "final", purpose: "replaying every tuning change before it goes live" },
    { title: "Case summary spec", type: "doc", kind: "spec", topic: "handling", status: "final", purpose: "the pre-filled case summary" },
    { title: "Risk score spec", type: "doc", kind: "spec", topic: "scoring", status: "in review", purpose: "the inputs and thresholds of the risk score" },
    { title: "Weekend cover proposal", type: "doc", kind: "proposal", topic: "queue", status: "draft", purpose: "one analyst on call at weekends" },
    { title: "Analyst training plan", type: "doc", kind: "plan", topic: "training", status: "final", purpose: "the first two weeks of a new analyst" },
    { title: "Document check spec", type: "doc", kind: "spec", topic: "automation", status: "final", purpose: "how identity documents are checked" },
    {
      title: "Queue size tracker", type: "sheet", topic: "queue", status: "final", master: true,
      rows: [
        "Week one of automation, 1,200 cases in the queue",
        "Week four of automation, 760 cases in the queue",
        "Week eight of automation, 410 cases in the queue",
        "This week, 340 cases in the queue"
      ]
    },
    {
      title: "Tuning results sheet", type: "sheet", topic: "alerts", status: "final",
      rows: [
        "Change accent matching, false positives down 14 points",
        "Change word order matching, false positives down 9 points",
        "Change date of birth tolerance, false positives down 4 points",
        "Change short name rule, rejected after the replay"
      ]
    },
    {
      title: "Handling time by case type", type: "sheet", topic: "handling", status: "final",
      rows: [
        "Case type address change, 6 minutes at the median",
        "Case type new business account, 22 minutes at the median",
        "Case type name match review, 11 minutes at the median",
        "Case type document expiry, 4 minutes at the median"
      ]
    },
    {
      title: "Escalation rates sheet", type: "sheet", topic: "escalation", status: "in review",
      rows: [
        "Team north, 7% of cases escalated",
        "Team south, 9% of cases escalated",
        "Team west, 6% of cases escalated",
        "All teams, 20% fewer escalations than before the scoring change"
      ]
    },
    {
      title: "Audit evidence sheet", type: "sheet", topic: "evidence", status: "final", access: AUDIT,
      rows: [
        "Sample one, 50 cases, every record complete",
        "Sample two, 50 cases, two records missing a rule version",
        "Sample three, 50 cases, every record complete",
        "Open fix, rule version added to every new record"
      ]
    },
    { title: "KYC automation review slides", type: "slides", topic: "automation", status: "final", master: true, purpose: "where KYC review automation stands" },
    { title: "Tuning results slides", type: "slides", topic: "alerts", status: "final", purpose: "what alert tuning changed" },
    { title: "Queue progress slides", type: "slides", topic: "queue", status: "final", purpose: "the review queue since automation started" },
    { title: "Analyst training slides", type: "slides", topic: "training", status: "draft", purpose: "the new analyst training" },
    { title: "Exported audit summary", type: "pdf", kind: "summary", topic: "evidence", status: "final", purpose: "the last audit sample and its findings", access: AUDIT }
  ],
  channels: [
    { name: "kyc-review-queue", status: "the queue is down to 340 cases from 1,200, and pre-filled summaries are in review",
      topics: ["queue", "handling"], visibility: "public", agreements: [1, 2] },
    { name: "kyc-alert-tuning", status: "false positives are down to 44% of alerts, and the account age change is in review",
      topics: ["alerts", "scoring"], visibility: "public", agreements: [0, 3] },
    { name: "kyc-automation", status: "automatic checks clear 58% of cases, and second reviews for escalated cases are in progress",
      topics: ["automation", "escalation"], visibility: "public" },
    {
      name: "kyc-audit-evidence", status: "the evidence index covers 18 thousand closed cases so far",
      topics: ["evidence"], visibility: "private",
      access: { groups: ["risk"], members: ["risk"], tier: "restricted" }
    },
    { name: "kyc-standup", status: "the queue is at 340 cases, and automatic checks clear 58% of cases",
      topics: ["queue", "alerts", "automation", "training"], visibility: "public" }
  ],
  agreements: [
    "Agreed: {r1} replays each tuning change on the previous month's alerts.",
    "Decision: cases are picked by risk score, not arrival time.",
    "Approved: {r2} keeps one analyst on call at weekends.",
    "OK, let's hold the tuning board every second Wednesday."
  ],
  trackedBy: 2,
  copies: {
    superseded: [{ title: "Automation rollout plan", older: [["58%", "31%"], ["340 cases", "980 cases"]] }],
    near: [{ of: "Escalation guide", title: "Senior analyst handbook", changes: [] }]
  }
};
