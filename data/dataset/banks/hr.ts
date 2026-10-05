import type { Access, Bank } from "../types.js";

/** Pay pages and sheets: restricted to people operations. */
const COMP: Access = { public: false, tier: "restricted", restrictTo: ["people-ops"] };

export const PEOPLE: Bank = {
  key: "PEOPLE",
  name: "People",
  project: false,
  owners: ["people-ops"],
  tier: "internal",
  public: true,
  roles: { h1: ["people-ops"], h2: ["people-ops"], h3: ["people-ops"] },
  fileOwner: "h1",
  topics: [
    {
      id: "leave", name: "annual leave",
      facts: [
        "everyone gets 25 days of annual leave plus public holidays",
        "up to five unused days carry over to the next year",
        "leave is booked in the HR system at least two weeks ahead for anything longer than a week"
      ]
    },
    {
      id: "parental", name: "parental leave",
      facts: [
        "birth parents get 26 weeks of fully paid leave",
        "partners get 12 weeks of fully paid leave",
        "parental leave can be taken in up to three blocks within two years"
      ]
    },
    {
      id: "expenses", name: "expenses",
      facts: [
        "expenses are claimed in the expense tool within 30 days",
        "meals on business trips are covered up to 60 dollars a day",
        "receipts are needed for anything over 25 dollars"
      ]
    },
    {
      id: "remote", name: "remote work",
      facts: [
        "everyone may work remotely up to three days a week",
        "teams agree on at least one shared office day each week",
        "a home office allowance of 400 dollars is paid once"
      ]
    },
    {
      id: "travel", name: "business travel",
      facts: [
        "flights under six hours are booked in economy",
        "trips are booked through the travel desk at least ten days ahead",
        "hotels are booked within the city rate set by the travel desk"
      ]
    },
    {
      id: "learning", name: "learning budget",
      facts: [
        "everyone has a learning budget of 1,500 dollars a year",
        "the budget covers courses, books and conference tickets",
        "managers approve learning requests within a week"
      ]
    },
    {
      id: "conduct", name: "code of conduct",
      facts: [
        "everyone is expected to treat colleagues with respect",
        "concerns can be raised with a manager or with people operations",
        "every concern is handled confidentially"
      ]
    },
    {
      id: "equipment", name: "equipment",
      facts: [
        "new starters choose a laptop from the approved list",
        "laptops are replaced every three years",
        "broken equipment is swapped at the help desk within a day"
      ]
    },
    {
      id: "holidays", name: "public holidays",
      facts: [
        "each office follows the public holidays of its country",
        "people who work on a public holiday get another day off",
        "the holiday list for each office is in the HR system"
      ]
    },
    {
      id: "reviews", name: "performance reviews",
      facts: [
        "performance reviews happen twice a year",
        "each review has a self review, a peer review and a manager review",
        "goals are set with the manager at the start of each half"
      ]
    },
    {
      id: "bands", name: "salary bands",
      facts: [
        "each role has a salary band with a minimum, a midpoint and a maximum",
        "bands are checked against market data every year",
        "offers above the midpoint need approval from people operations"
      ]
    },
    {
      id: "equity", name: "equity refresh",
      facts: [
        "equity refresh grants are reviewed once a year",
        "refresh grants vest over four years",
        "managers nominate people for a refresh after the second review of the year"
      ]
    },
    {
      id: "bonus", name: "bonus guidelines",
      facts: [
        "the yearly bonus target is 8% of base salary for most roles",
        "bonuses depend on company results and individual goals",
        "bonuses are paid with the salary after the second review of the year"
      ]
    },
    {
      id: "hiring", name: "hiring",
      facts: [
        "every open role has an approved headcount and a hiring manager",
        "interview panels have at least one person from another team",
        "candidates hear back within five working days of an interview"
      ],
      question: [
        "Can a hiring manager skip the panel for an internal move?",
        "{h2} answered that internal moves still need one interview with the new team"
      ]
    }
  ],
  pages: [
    { title: "Leave policy", kind: "policy", topic: "leave", purpose: "annual leave and how to book it" },
    { title: "Parental leave policy", kind: "policy", topic: "parental", purpose: "leave for new parents" },
    { title: "Expenses policy", kind: "policy", topic: "expenses", purpose: "what the company pays back and how to claim it" },
    { title: "Remote work policy", kind: "policy", topic: "remote", purpose: "working from home and shared office days" },
    { title: "Travel policy", kind: "policy", topic: "travel", purpose: "booking business travel" },
    { title: "Learning budget policy", kind: "policy", topic: "learning", purpose: "the yearly learning budget" },
    { title: "Code of conduct", kind: "policy", topic: "conduct", purpose: "how we treat each other and how to raise a concern" },
    { title: "Equipment policy", kind: "policy", topic: "equipment", purpose: "laptops and other equipment" },
    { title: "Public holidays guide", kind: "policy", topic: "holidays", purpose: "public holidays in each office" },
    { title: "Performance review policy", kind: "policy", topic: "reviews", purpose: "how and when performance reviews happen" },
    { title: "Salary bands", kind: "reference", topic: "bands", purpose: "the salary band of each role", access: COMP },
    { title: "Equity refresh guidelines", kind: "reference", topic: "equity", purpose: "how equity refresh grants are decided", access: COMP },
    { title: "Bonus guidelines", kind: "reference", topic: "bonus", purpose: "how yearly bonuses are set and paid", access: COMP }
  ],
  files: [
    {
      title: "Salary band sheet", type: "sheet", topic: "bands", status: "final", access: COMP,
      rows: [
        "Band engineer two, midpoint 96 thousand, range 82 to 110 thousand",
        "Band engineer three, midpoint 118 thousand, range 101 to 135 thousand",
        "Band designer two, midpoint 88 thousand, range 75 to 101 thousand",
        "Band analyst two, midpoint 84 thousand, range 72 to 96 thousand"
      ]
    },
    {
      title: "Merit increase sheet", type: "sheet", topic: "bands", status: "in review", access: COMP,
      rows: [
        "Rating exceeds, increase 6% to 8%",
        "Rating meets, increase 3% to 5%",
        "Rating developing, increase 0% to 2%",
        "Budget, 4.2% of total salary across the company"
      ]
    }
  ],
  channels: [
    {
      name: "people-ops", topics: ["hiring", "reviews", "bands"], visibility: "private",
      access: { public: false, members: ["people-ops"] }
    }
  ]
};
