import type { Bank } from "../types.js";

// Everyone can read this space, Alex the intern included, so nothing here names a project, a team channel or a page
// that only some people can open.
export const COMPANY: Bank = {
  key: "COMPANY",
  name: "Company",
  project: false,
  owners: [],
  tier: "open",
  public: true,
  roles: { o1: ["people-ops"], o2: ["people-ops"], d1: ["design"], t1: ["platform"], f1: ["finance"] },
  fileOwner: "o1",
  topics: [
    {
      id: "welcome", name: "life at Aspire",
      facts: [
        "Aspire has offices in Singapore, London and Toronto",
        "about 400 people work at Aspire across the three offices",
        "every new starter gets a buddy for their first month",
        "the company newsletter goes out every second Friday"
      ]
    },
    {
      id: "office", name: "the Singapore office",
      facts: [
        "the Singapore office is open from 07:00 to 21:00 on weekdays",
        "visitors sign in at the front desk on level 12",
        "the new floor on level 14 adds 60 desks and four meeting rooms",
        "lockers on level 12 are free to use for the day"
      ]
    },
    {
      id: "rooms", name: "meeting rooms",
      facts: [
        "meeting rooms are booked in the calendar for up to two hours",
        "a room with no one in it after 10 minutes is released",
        "the large room on level 14 seats 40 people"
      ],
      steps: [
        "open a calendar invite and add the room as a guest",
        "pick a room that fits the number of people",
        "release the room if the meeting is cancelled"
      ]
    },
    {
      id: "values", name: "company values",
      facts: [
        "the first company value is to start with the customer",
        "the second value is to write things down so others can follow",
        "the third value is to own the outcome, not just the task",
        "values are part of every performance conversation"
      ]
    },
    {
      id: "floor", name: "the new office floor",
      facts: [
        "the new floor on level 14 opened with 60 desks",
        "level 14 has four meeting rooms and two phone booths",
        "the quiet zone on level 14 has no calls or meetings",
        "desks on level 14 are booked in the desk app"
      ]
    },
    {
      id: "goals", name: "company goals for this half",
      facts: [
        "the first goal this half is to grow active customers by 15%",
        "the second goal is to answer every customer within one working day",
        "the third goal is to open the new Toronto office",
        "progress on the goals is shared at every all-hands",
        "active customers are up 9% so far this half",
        "nine in ten customer questions get an answer within one working day",
        "the Toronto office fit-out is half done"
      ]
    },
    {
      id: "awards", name: "team awards",
      facts: [
        "this half's customer award went to the support team in Toronto",
        "the builder award went to the people who opened the new floor",
        "anyone can nominate a colleague for an award",
        "award winners choose a charity for a donation of 1,000 dollars"
      ]
    },
    {
      id: "wellness", name: "wellness week",
      facts: [
        "wellness week has a yoga class every morning",
        "lunch talks during wellness week cover sleep, focus and stretching",
        "fruit is free in every kitchen during wellness week"
      ]
    },
    {
      id: "helpdesk", name: "IT help desk",
      facts: [
        "the IT help desk on level 12 is open from 08:30 to 18:00",
        "a lost laptop is replaced on the same day",
        "help desk tickets are answered within four working hours",
        "new monitors are collected at the help desk"
      ],
      question: [
        "Can I get a second monitor for my desk at home?",
        "{t1} answered that the help desk ships one if your manager approves it"
      ]
    },
    {
      id: "kitchen", name: "kitchens",
      facts: [
        "every floor has a kitchen with coffee and tea",
        "the coffee machines are cleaned every evening",
        "fridges are cleared every Friday at 16:00"
      ]
    },
    {
      id: "volunteer", name: "volunteer day",
      facts: [
        "everyone gets one paid volunteer day a year",
        "this half's volunteer day is a beach clean-up near each office",
        "teams can also choose their own charity for the day"
      ]
    },
    {
      id: "bikes", name: "bike parking",
      facts: [
        "bike parking is in the basement with space for 80 bikes",
        "showers and towels are on level 12",
        "the bike room opens with your door badge"
      ]
    }
  ],
  pages: [
    { title: "Welcome to Aspire", kind: "announcement", topic: "welcome", purpose: "welcome to Aspire, and here is what to know in your first week" },
    { title: "Singapore office guide", kind: "reference", topic: "office", purpose: "how the Singapore office works" },
    { title: "Meeting room booking guide", kind: "howto", topic: "rooms", purpose: "book a meeting room" },
    {
      title: "Company values", kind: "reference", topic: "values", purpose: "the three company values",
      say: ["The first value is to start with the customer.", "The second value is to write things down so others can follow.",
        "The third value is to own the outcome, not just the task."]
    },
    { title: "All-hands summary: the new office floor", kind: "announcement", topic: "floor", purpose: "the new office floor opened on level 14" },
    { title: "All-hands summary: goals for this half", kind: "announcement", topic: "goals", purpose: "the company goals for this half" },
    { title: "All-hands summary: team awards", kind: "announcement", topic: "awards", purpose: "this half's team awards" },
    { title: "Wellness week announcement", kind: "announcement", topic: "wellness", purpose: "wellness week starts next Monday" },
    { title: "IT help desk hours", kind: "reference", topic: "helpdesk", purpose: "when and how the IT help desk can help" },
    { title: "Kitchen and coffee guide", kind: "reference", topic: "kitchen", purpose: "how the kitchens work" },
    { title: "Company goals for this half", kind: "reference", topic: "goals", purpose: "the goals every team works toward this half" },
    { title: "Volunteer day announcement", kind: "announcement", topic: "volunteer", purpose: "this half's volunteer day" },
    { title: "Bike parking and showers", kind: "reference", topic: "bikes", purpose: "bike parking and showers at the Singapore office" }
  ],
  files: [
    { title: "Level 14 floor plan guide", type: "doc", kind: "guide", topic: "rooms", status: "final", purpose: "how to find and book rooms on level 14" },
    { title: "Wellness week schedule", type: "doc", kind: "brief", topic: "wellness", status: "final", purpose: "the classes and talks during wellness week" },
    { title: "Company goals summary", type: "doc", kind: "brief", topic: "goals", status: "final", purpose: "the three company goals for this half" },
    { title: "All-hands slides: the new office floor", type: "slides", topic: "floor", status: "final", purpose: "welcome to level 14" },
    { title: "All-hands slides: goals for this half", type: "slides", topic: "goals", status: "final", purpose: "where we are on the goals for this half" },
    { title: "All-hands slides: team awards", type: "slides", topic: "awards", status: "final", purpose: "this half's award winners" }
  ],
  channels: [
    { name: "general", topics: ["welcome", "values"], visibility: "public" },
    { name: "announcements", topics: ["goals", "volunteer"], visibility: "public" },
    { name: "office-life", topics: ["office", "kitchen", "bikes"], visibility: "public" },
    { name: "help-desk", topics: ["helpdesk"], visibility: "public" },
    { name: "all-hands", topics: ["floor", "awards", "wellness"], visibility: "public" }
  ]
};
