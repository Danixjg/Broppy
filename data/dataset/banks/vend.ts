import type { Access, Bank } from "../types.js";

/** Shared with the partner: Wei Ming and the two partner contractors. */
const SHARED: Access = { partner: true };

export const VEND: Bank = {
  key: "VEND",
  name: "Partner API integration",
  project: true,
  owners: ["platform"],
  tier: "internal",
  roles: { lead: ["platform", "eng-leads"], e1: ["platform"], e2: ["platform"], e3: ["platform"] },
  partner: ["wei", "c1", "c2"],
  fileOwner: "e1",
  masterAccess: SHARED,
  goal: "the partner's systems create and track orders through our public API, with webhooks they can rely on",
  status: [
    "the API contract is signed and the sandbox is open to the partner",
    "webhook retries pass in the sandbox",
    "production go-live waits on the rate limit test"
  ],
  topics: [
    {
      id: "contract", name: "API contract",
      facts: [
        "the API contract covers orders, shipments and webhooks",
        "version 1 of the contract is frozen for six months",
        "a breaking change needs 90 days of notice to the partner",
        "Wei Ming signed off the field names for the partner team"
      ],
      question: [
        "Can the partner add a field to version 1?",
        "{lead} answered that new optional fields are fine, but nothing can be renamed or removed"
      ],
      decision: "version 1 of the contract is frozen for six months"
    },
    {
      id: "sandbox", name: "sandbox",
      facts: [
        "the sandbox mirrors production with test data",
        "partner test keys rotate every 30 days",
        "the sandbox resets every Sunday at 02:00",
        "sandbox access is shared with Wei Ming and the two partner contractors"
      ],
      steps: [
        "ask for a test key in the partner channel",
        "call the orders endpoint with the test key and check the response",
        "send a test webhook from the sandbox console and acknowledge it"
      ]
    },
    {
      id: "webhooks", name: "webhook retries",
      facts: [
        "a failed webhook is retried 6 times over 24 hours",
        "each webhook will carry an idempotency key",
        "the partner acknowledges a webhook within 5 seconds",
        "a repeated webhook is processed only once"
      ],
      question: [
        "What happens if the partner is down for a whole day?",
        "{e1} answered that the last retry waits 12 hours, so nothing is lost within 24 hours"
      ],
      decision: "a failed webhook is retried 6 times over 24 hours"
    },
    {
      id: "limits", name: "rate limits",
      facts: [
        "the partner may send 50 requests per second",
        "a burst of 200 requests is allowed for 10 seconds",
        "the rate limit test runs against the sandbox before go-live"
      ],
      risk: "go-live could slip if the partner's test window moves again"
    },
    {
      id: "errors", name: "error codes",
      facts: [
        "every error response carries a stable code and a message",
        "Wei Ming will own the mapping of partner error codes",
        "the stable error code list has 34 entries"
      ]
    }
  ],
  issues: [
    { topic: "contract", summary: "Freeze version 1 of the API contract", what: "freezes version 1 of the order and shipment API contract", acceptance: "the partner confirms the frozen field names", status: "done", access: SHARED },
    { topic: "webhooks", summary: "Retry failed webhooks", what: "retries a failed webhook 6 times over 24 hours", acceptance: "a test webhook arrives after five failed attempts", status: "done", access: SHARED },
    { topic: "limits", summary: "Run the rate limit test", what: "runs the rate limit test against the sandbox", acceptance: "the sandbox holds 50 requests per second with bursts of 200", status: "blocked", blockedBy: "waits on the partner's test window", access: SHARED },
    { topic: "errors", summary: "Map partner error codes", what: "maps the partner's error codes to our 34 stable codes", acceptance: "every partner error shows a stable code", status: "in progress", access: SHARED },
    { topic: "sandbox", summary: "Rotate partner test keys", what: "rotates the partner test keys every 30 days", acceptance: "no partner key is older than 30 days", status: "in progress" },
    { topic: "webhooks", summary: "Add idempotency keys to webhooks", what: "adds an idempotency key to every webhook", acceptance: "a repeated webhook is processed once", status: "in review", access: SHARED },
    { topic: "limits", summary: "Alert on partner rate limit hits", what: "alerts the platform on-call engineer when the partner hits the rate limit", acceptance: "a test burst raises the alert", status: "open" },
    { topic: "contract", summary: "Plan version 2 of the API contract", what: "plans the fields for version 2 of the contract", acceptance: "the version 2 draft is ready for the partner", status: "open" }
  ],
  masterIssues: [1, 2, 3, 4],
  pages: [
    { title: "Partner API contract", kind: "reference", topic: "contract", purpose: "the endpoints, fields and error codes of version 1", access: SHARED },
    {
      title: "Sandbox setup guide", kind: "howto", topic: "sandbox", purpose: "make a first call against the sandbox", access: SHARED,
      say: ["The sandbox was shared with Wei Ming and the two partner contractors."]
    },
    { title: "Webhook retry design", kind: "design", topic: "webhooks", purpose: "how failed webhooks are retried and deduplicated", access: SHARED },
    {
      title: "Partner commercial review", kind: "meeting", topic: "limits",
      access: { groups: ["eng-leads"], restrictTo: ["eng-leads"] }
    }
  ],
  files: [
    { title: "Signed partner API contract", type: "pdf", kind: "contract", topic: "contract", status: "final", master: true, purpose: "version 1 of the order and shipment API", access: SHARED },
    { title: "Webhook payload examples", type: "doc", kind: "spec", topic: "webhooks", status: "final", master: true, purpose: "example payloads for every webhook", access: SHARED },
    {
      title: "Partner error code mapping", type: "doc", kind: "spec", topic: "errors", status: "in review", purpose: "how partner error codes map to our stable codes",
      access: { partner: true, owner: "wei" }, say: ["Wei Ming will own the mapping of partner error codes until go-live."]
    },
    {
      title: "Partner webhook test plan", type: "doc", kind: "plan", topic: "webhooks", status: "final", purpose: "the webhook tests the partner runs in the sandbox",
      access: { partner: true, owner: "wei" }, say: ["This plan is shared with Wei Ming and the partner contractors.", "Wei Ming will own the test runs on the partner side."]
    },
    { title: "Sandbox access checklist", type: "doc", kind: "checklist", topic: "sandbox", status: "final", purpose: "giving a partner engineer sandbox access" },
    {
      title: "Rate limit test results", type: "sheet", topic: "limits", status: "draft", access: SHARED,
      rows: [
        "Run one, 50 requests per second for 10 minutes, no errors",
        "Run two, bursts of 200 requests for 10 seconds, 3 throttled",
        "Run three, 60 requests per second, throttled as designed",
        "Run four, waiting on the partner's test window"
      ]
    },
    { title: "Partner go-live slides", type: "slides", topic: "limits", status: "draft", purpose: "the plan for the partner's production go-live" }
  ],
  channels: [
    {
      name: "vend-partner-api", status: "version 1 is frozen, webhook retries are live, and the error code mapping is in progress",
      topics: ["contract", "errors", "webhooks"], visibility: "private", access: SHARED, agreements: [0, 1],
      say: ["The error code mapping is shared with Wei Ming in the partner folder."]
    },
    { name: "vend-sandbox", status: "the sandbox is open to the partner, and the rate limit test waits on their test window",
      topics: ["sandbox", "limits"], visibility: "private", access: SHARED, agreements: [2] },
    { name: "vend-internal", status: "go-live waits on the rate limit test, and key rotation is in progress",
      topics: ["limits", "sandbox"], visibility: "private", agreements: [3] }
  ],
  agreements: [
    "Agreed: Wei Ming owns the error code mapping for the partner.",
    "Decision: webhooks retry 6 times over 24 hours.",
    "Let's go with 50 requests per second for the partner.",
    "Approved: {e1} rotates the partner test keys every 30 days."
  ],
  trackedBy: 4,
  copies: {
    superseded: [{ title: "Rate limit test results", older: [["50 requests per second for 10 minutes", "30 requests per second for 10 minutes"], ["3 throttled", "41 throttled"]] }],
    near: [{ of: "Sandbox access checklist", title: "Sandbox steps for partner engineers", changes: [] }]
  }
};
