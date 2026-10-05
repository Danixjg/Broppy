import type { Bank } from "../types.js";

export const LEGAL: Bank = {
  key: "LEGAL",
  name: "Legal",
  project: false,
  owners: ["legal"],
  tier: "restricted",
  roles: { gc: ["legal"], l1: ["legal"], l2: ["legal"] },
  fileOwner: "gc",
  topics: [
    {
      id: "contracts", name: "contract reviews",
      facts: [
        "every customer contract over 50 thousand dollars gets a legal review",
        "standard reviews come back within three working days",
        "redlines are tracked in the contract review log",
        "non-standard liability caps need sign-off from the general counsel"
      ],
      steps: [
        "send the draft with the deal size and the deadline",
        "wait for the redlines from the assigned lawyer",
        "ask for sign-off from the general counsel if the liability cap changed"
      ]
    },
    {
      id: "issuer", name: "card issuer terms",
      facts: [
        "the card issuer terms are in their third round of redlines",
        "the termination clause still allows the issuer to exit on 30 days of notice",
        "the data sharing schedule limits spend data to what rewards need",
        "the issuer agreed to fund points earned on travel spend"
      ],
      decision: "we ask for 90 days of notice before the issuer can exit"
    },
    {
      id: "dpa", name: "data processing addendum",
      facts: [
        "the standard data processing addendum lists 14 subprocessors",
        "customers get 30 days of notice before a new subprocessor starts",
        "personal data stays in the region the customer chose"
      ]
    },
    {
      id: "nda", name: "NDA template",
      facts: [
        "the mutual NDA template covers two years of confidentiality",
        "sales may sign the template without changes",
        "any change to the template goes to legal first"
      ],
      steps: [
        "download the current mutual NDA template",
        "fill in the company name and the purpose",
        "send any requested change to legal before signing"
      ]
    },
    {
      id: "trademarks", name: "trademarks",
      facts: [
        "the company name is registered in 11 countries",
        "a new product name gets a clearance search before it is announced",
        "trademark renewals are tracked by the legal team"
      ]
    },
    {
      id: "oss", name: "open source licences",
      facts: [
        "permissive licences are approved for any use",
        "copyleft licences need a legal review before they ship in a product",
        "the licence scanner runs on every release build"
      ]
    },
    {
      id: "lease", name: "office lease",
      facts: [
        "the head office lease ends in two years",
        "the renewal offer adds a fourth floor at the same rate",
        "the landlord asked for an answer within six weeks"
      ],
      decision: "we accept the renewal offer if the fourth floor is ready within a year"
    }
  ],
  pages: [
    { title: "Card issuer terms review", kind: "meeting", topic: "issuer" },
    { title: "Data processing addendum review", kind: "reference", topic: "dpa", purpose: "what the standard data processing addendum promises" },
    { title: "NDA template guide", kind: "howto", topic: "nda", purpose: "use the mutual NDA template" },
    { title: "Trademark clearance checklist", kind: "reference", topic: "trademarks", purpose: "how product names are cleared and registered" },
    { title: "Open source licence review", kind: "reference", topic: "oss", purpose: "which open source licences we accept" },
    { title: "Office lease renewal review", kind: "meeting", topic: "lease" },
    { title: "Contract review process", kind: "howto", topic: "contracts", purpose: "get a customer contract reviewed" }
  ],
  files: [
    { title: "Contract review checklist", type: "doc", kind: "checklist", topic: "contracts", status: "final", purpose: "a customer contract review" },
    { title: "Standard clause library", type: "doc", kind: "spec", topic: "contracts", status: "final", purpose: "the clauses we accept without a review" },
    { title: "Signed office lease extension", type: "pdf", kind: "contract", topic: "lease", status: "final", purpose: "extending the head office lease while the renewal is agreed" },
    { title: "Signed mutual NDA with a hardware partner", type: "pdf", kind: "contract", topic: "nda", status: "final", purpose: "sharing hardware plans for the new office" }
  ],
  channels: [{ name: "legal-contracts", topics: ["contracts", "issuer", "lease"], visibility: "private" }]
};
