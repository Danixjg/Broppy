import type { Bank } from "../types.js";

export const CARD: Bank = {
  key: "CARD",
  name: "Corporate card rewards",
  project: true,
  owners: ["product", "finance", "design"],
  tier: "internal",
  roles: { pm: ["product"], p2: ["product"], f1: ["finance"], f2: ["finance"], d1: ["design"], d2: ["design"], l1: ["legal"] },
  fileOwner: "pm",
  goal: "corporate cardholders earn rewards on every purchase, with clear tiers and no surprise caps",
  status: [
    "the reward tiers are signed off and the pricing sheet is final",
    "the partner terms are with legal for a last review",
    "go-live follows the signed partner terms and a four-week pilot"
  ],
  topics: [
    {
      id: "overview", name: "corporate card rewards",
      facts: [
        "the three reward tiers are signed off",
        "the partner terms are in a last legal review",
        "a four-week pilot with 200 cardholders comes before go-live",
        "the rewards page is in design review",
        "reward cost is modelled under 0.9% of spend"
      ]
    },
    {
      id: "tiers", name: "reward tiers",
      facts: [
        "there are three reward tiers called Standard, Plus and Premier",
        "Standard earns 1 point per dollar and Premier earns 2",
        "points never expire while the account is open",
        "tier upgrades happen at the start of each billing cycle",
        "Plus earns 1.5 points per dollar",
        "a cardholder moves up a tier after spending 50 thousand dollars in a year"
      ],
      question: [
        "Do points expire when a cardholder leaves their company?",
        "{pm} answered that points stay for 12 months after an account closes"
      ],
      decision: "points never expire while the account is open"
    },
    {
      id: "pricing", name: "pricing sheet",
      facts: [
        "the annual fee is 0 for Standard, 120 for Plus and 400 for Premier",
        "the pricing sheet models 4,800 cardholders in the first year",
        "reward cost stays under 0.9% of spend in the pricing model",
        "finance signed off the pricing model"
      ]
    },
    {
      id: "caps", name: "cashback caps",
      facts: [
        "cashback is capped at 2,000 dollars a year per card",
        "cardholders see their cap progress on the rewards page",
        "travel spend earns double points up to the cap"
      ],
      risk: "a cap set too low could push large customers to another card",
      decision: "cashback is capped at 2,000 dollars a year per card"
    },
    {
      id: "terms", name: "partner terms",
      facts: [
        "the card issuer terms cover points funding and data sharing",
        "legal is reviewing the termination clause",
        "the partner shares spend data once a day",
        "the issuer funds the points earned on travel spend"
      ],
      question: [
        "When can the daily spend feed start?",
        "{f1} answered that it starts the week after both sides sign the terms"
      ],
      risk: "go-live could slip if the termination clause needs another round"
    },
    {
      id: "golive", name: "go-live",
      facts: [
        "go-live follows the signed partner terms",
        "the first 200 cardholders join a pilot for four weeks",
        "support agents get a rewards guide before the pilot starts",
        "the go-live announcement goes out after the pilot",
        "pilot cardholders get a short survey after two weeks",
        "the pilot ends with a review of points, caps and support questions",
        "go-live opens rewards to every corporate cardholder at once"
      ],
      decision: "the first 200 cardholders join a four-week pilot before go-live"
    },
    {
      id: "categories", name: "spend categories",
      facts: [
        "spend is grouped into 9 categories for rewards",
        "travel and software spend earn double points",
        "category rules follow the issuer's merchant codes",
        "dining and office supplies earn the standard rate",
        "a merchant code that fits no category earns the standard rate",
        "the category list is reviewed with finance every six months"
      ],
      steps: [
        "find the merchant codes for the new category in the issuer's list",
        "add the category and its earn rate to the mapping sheet",
        "test a purchase in the sandbox before the change goes live"
      ]
    },
    {
      id: "page", name: "rewards page",
      facts: [
        "the rewards page shows points, tier and cap progress",
        "usability tests with 8 finance managers shaped the layout",
        "the tier badge uses the brand colours",
        "the cap progress bar turns amber at 80% of the cap",
        "the rewards page works on phones as well as on desktop browsers",
        "finance managers can download every cardholder's points as a spreadsheet"
      ]
    }
  ],
  issues: [
    { topic: "tiers", summary: "Set up the three reward tiers", what: "sets up the Standard, Plus and Premier tiers with their earn rates", acceptance: "each tier earns the agreed points per dollar in a test", status: "done" },
    { topic: "caps", summary: "Apply the yearly cashback cap", what: "applies a cashback cap of 2,000 dollars a year per card", acceptance: "a test card stops earning cashback at the cap", status: "in progress" },
    { topic: "terms", summary: "Finish the partner terms review", what: "finishes the review of the card issuer terms with legal", acceptance: "both sides sign the terms", status: "blocked", blockedBy: "waits on legal's review of the termination clause" },
    { topic: "pricing", summary: "Finalise the pricing sheet", what: "finalises the fees and reward cost in the pricing sheet", acceptance: "finance signs off the pricing sheet", status: "done" },
    { topic: "golive", summary: "Run a four-week pilot", what: "runs a four-week pilot with the first 200 cardholders", acceptance: "pilot cardholders earn and see points without errors", status: "open" },
    { topic: "categories", summary: "Map merchant codes to categories", what: "maps the issuer's merchant codes to 9 reward categories", acceptance: "every test purchase lands in the right category", status: "in progress" },
    { topic: "page", summary: "Build the rewards page", what: "builds the rewards page with points, tier and cap progress", acceptance: "the page matches the approved design", status: "in review" },
    { topic: "tiers", summary: "Upgrade tiers at the start of each cycle", what: "upgrades a cardholder's tier at the start of each billing cycle", acceptance: "a test upgrade applies on the first day of the cycle", status: "in progress" },
    { topic: "golive", summary: "Write the support rewards guide", what: "writes the rewards guide for support agents", acceptance: "agents answer the 10 most common questions from the guide", status: "open" },
    { topic: "terms", summary: "Set up the daily spend data feed", what: "sets up the daily spend data feed from the partner", acceptance: "spend data arrives by 07:00 every day for a week", status: "blocked", blockedBy: "waits on the signed partner terms" },
    { topic: "categories", summary: "Double points for travel and software", what: "doubles points for travel and software spend", acceptance: "a test purchase in each category earns double points", status: "in review" },
    { topic: "page", summary: "Test the rewards page with finance managers", what: "runs usability tests with 8 finance managers", acceptance: "at least 6 of 8 find their cap progress unaided", status: "done" },
    { topic: "pricing", summary: "Track reward cost against spend", what: "tracks reward cost as a share of spend each week", acceptance: "reward cost stays under 0.9% of spend in the pilot", status: "open" },
    { topic: "golive", summary: "Plan the go-live announcement", what: "plans the announcement to cardholders after the pilot", acceptance: "product and finance approve the announcement", status: "open" }
  ],
  masterIssues: [2, 3, 5, 7],
  pages: [
    { title: "Reward tier design", kind: "design", topic: "tiers", purpose: "the three reward tiers and how cardholders move between them" },
    { title: "Decision record: points never expire", kind: "decision", topic: "tiers" },
    { title: "Decision record: yearly cashback cap", kind: "decision", topic: "caps" },
    { title: "Rewards sync: pricing sign-off", kind: "meeting", topic: "pricing" },
    { title: "Rewards sync: partner terms", kind: "meeting", topic: "terms" },
    { title: "How to add a reward category", kind: "howto", topic: "categories", purpose: "add a new reward category" },
    { title: "Rewards page design", kind: "design", topic: "page", purpose: "what cardholders see on the rewards page" },
    { title: "Corporate rewards pilot plan", kind: "design", topic: "golive", purpose: "the four-week pilot before go-live" },
    { title: "Spend category rules", kind: "reference", topic: "categories", purpose: "the spend categories and their earn rates" }
  ],
  files: [
    { title: "Partner terms summary", type: "doc", kind: "brief", topic: "terms", status: "final", master: true, purpose: "the card issuer terms under review" },
    { title: "Rewards programme proposal", type: "doc", kind: "proposal", topic: "tiers", status: "final", purpose: "three reward tiers for corporate cardholders" },
    { title: "Pilot plan for the first 200 cardholders", type: "doc", kind: "plan", topic: "golive", status: "final", purpose: "the four-week pilot" },
    { title: "Support rewards guide", type: "doc", kind: "guide", topic: "categories", status: "draft", purpose: "how support agents explain reward categories" },
    { title: "Category mapping spec", type: "doc", kind: "spec", topic: "categories", status: "in review", purpose: "how merchant codes map to reward categories" },
    { title: "Rewards page spec", type: "doc", kind: "spec", topic: "page", status: "final", purpose: "the rewards page" },
    { title: "Go-live announcement draft", type: "doc", kind: "brief", topic: "golive", status: "draft", purpose: "the announcement to cardholders after the pilot" },
    {
      title: "Reward pricing sheet", type: "sheet", topic: "pricing", status: "final", master: true,
      rows: [
        "Tier Standard, annual fee 0, 1 point per dollar, 3,100 cardholders modelled",
        "Tier Plus, annual fee 120, 1.5 points per dollar, 1,300 cardholders modelled",
        "Tier Premier, annual fee 400, 2 points per dollar, 400 cardholders modelled",
        "All tiers, reward cost 0.86% of spend, signed off by {f1}"
      ]
    },
    {
      title: "Category mapping sheet", type: "sheet", topic: "categories", status: "in review",
      rows: [
        "Category travel, double points, 41 merchant codes",
        "Category software, double points, 18 merchant codes",
        "Category office supplies, single points, 26 merchant codes",
        "Category dining, single points, 33 merchant codes"
      ]
    },
    {
      title: "Reward cost tracker", type: "sheet", topic: "pricing", status: "final",
      rows: [
        "Model week one, reward cost 0.84% of spend",
        "Model week two, reward cost 0.88% of spend",
        "Model week three, reward cost 0.86% of spend",
        "Limit, reward cost under 0.9% of spend"
      ]
    },
    {
      title: "Pilot cardholder list", type: "sheet", topic: "golive", status: "final",
      rows: [
        "Account Northwind Logistics, 24 cards, Plus tier",
        "Account Bluebell Studios, 12 cards, Standard tier",
        "Account Harbor Lane Partners, 60 cards, Premier tier",
        "Account Larch Labs, 104 cards, Plus tier"
      ]
    },
    {
      title: "Usability test results", type: "sheet", topic: "page", status: "final",
      rows: [
        "Task find cap progress, 7 of 8 finance managers succeeded",
        "Task compare tiers, 6 of 8 finance managers succeeded",
        "Task find travel points, 8 of 8 finance managers succeeded",
        "Task change the card nickname, 5 of 8 finance managers succeeded"
      ]
    },
    { title: "Card rewards go-live slides", type: "slides", topic: "overview", status: "final", master: true, purpose: "the plan for corporate card rewards go-live" },
    { title: "Reward tiers slides", type: "slides", topic: "tiers", status: "final", purpose: "the three reward tiers" },
    { title: "Pricing review slides", type: "slides", topic: "pricing", status: "final", purpose: "fees and reward cost", access: { users: ["c5"] } },
    { title: "Rewards page design slides", type: "slides", topic: "page", status: "in review", purpose: "the rewards page design" },
    { title: "Pilot results slides", type: "slides", topic: "golive", status: "draft", purpose: "what the pilot will measure" },
    { title: "Signed letter of intent with the card issuer", type: "pdf", kind: "contract", topic: "terms", status: "final", purpose: "working together on corporate card rewards" }
  ],
  channels: [
    { name: "card-rewards", status: "the three tiers are set up, and merchant code mapping is in progress",
      topics: ["tiers", "categories"], visibility: "public", agreements: [1] },
    { name: "card-pricing", status: "the pricing sheet is final, and the cashback cap is being built",
      topics: ["pricing", "caps"], visibility: "public", agreements: [0] },
    { name: "card-go-live", status: "the four-week pilot with 200 cardholders is planned, and the support guide comes next",
      topics: ["golive"], visibility: "public", agreements: [2] },
    { name: "card-partner-terms", status: "the issuer terms are still with legal, and the spend data feed waits on them",
      topics: ["terms"], visibility: "public" },
    { name: "card-design", status: "usability tests are done, and the rewards page is in review",
      topics: ["page"], visibility: "public", agreements: [3] }
  ],
  agreements: [
    "Agreed: {f1} models the cap at 2,000 dollars a year per card.",
    "Decision: points never expire while the account is open.",
    "Let's go with a four-week pilot for the first 200 cardholders.",
    "Approved: {d1} uses the brand colours for the tier badge."
  ],
  trackedBy: 2,
  copies: {
    superseded: [{ title: "Reward pricing sheet", older: [["annual fee 120", "annual fee 150"], ["0.86%", "1.1%"], ["1,300 cardholders", "900 cardholders"]] }],
    near: [{ of: "Partner terms summary", title: "Issuer agreement overview", changes: [] }]
  }
};
