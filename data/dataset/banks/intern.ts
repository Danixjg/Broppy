import type { Bank } from "../types.js";

// Interns and their two mentors read this space. It uses the words an intern's catch-up asks for (overview,
// milestones, workflow guides, what to read first) and names no project, team channel or restricted page.
export const INTERN: Bank = {
  key: "INTERN",
  name: "Interns",
  project: false,
  owners: ["interns"],
  tier: "open",
  grants: ["m1", "m2"],
  roles: {},
  fileOwner: "m1",
  topics: [
    {
      id: "overview", name: "intern programme",
      facts: [
        "the intern programme runs for twelve weeks",
        "every new hire in the programme reads the overview first",
        "each intern joins one team and works on one project",
        "interns meet their mentor every Tuesday and Thursday"
      ]
    },
    {
      id: "milestones", name: "intern milestones",
      facts: [
        "the first milestone is a working laptop and a first merged pull request by the end of week one",
        "the second milestone is a project plan agreed with the mentor by the end of week four",
        "the third milestone is a demo to the team by the end of week eight",
        "the final milestone is the company demo day in week twelve"
      ]
    },
    {
      id: "workflow", name: "team workflow",
      facts: [
        "the workflow guides explain branches, pull requests and reviews",
        "every change goes through a pull request, even a one-line fix",
        "interns pair with their mentor on their first three reviews",
        "a pull request needs one approval before it merges"
      ],
      steps: [
        "create a branch named after the task",
        "open a pull request with a short description of the change",
        "ask your mentor to review it before anyone else"
      ]
    },
    {
      id: "firstweek", name: "first week",
      facts: [
        "the first-week checklist covers the laptop, accounts and the cohort channel",
        "interns join the intern cohort channel on day one",
        "the first lunch is with the whole intern cohort",
        "laptops are ready at the help desk on the first morning"
      ],
      steps: [
        "collect your laptop at the help desk and sign in",
        "join the intern cohort channel and say hello",
        "book your first meeting with your mentor"
      ]
    },
    {
      id: "mentors", name: "mentors",
      facts: [
        "each intern has one mentor from the team they join",
        "{m1} and {m2} mentor this cohort",
        "mentors keep an hour free each week for questions"
      ]
    },
    {
      id: "projects", name: "intern projects",
      facts: [
        "each intern project is small enough to finish in eight weeks",
        "every project comes with a short brief and a named stakeholder",
        "this cohort's projects include a style checker, a help page search and a meeting room finder",
        "projects are chosen in the second week with the mentor"
      ]
    },
    {
      id: "demo", name: "demo day",
      facts: [
        "demo day is in the last week of the programme",
        "each demo lasts ten minutes with five minutes for questions",
        "demos are recorded for colleagues in the other offices"
      ],
      steps: [
        "write down the problem, what you built and what you learned",
        "rehearse the demo with your mentor a week before",
        "keep the live part of the demo under five minutes"
      ]
    },
    {
      id: "questions", name: "intern questions",
      facts: [
        "no question is too small for the intern questions channel",
        "questions are answered within one working day",
        "common questions are added to the questions and answers page"
      ],
      question: [
        "Where do I find the workflow guides?",
        "{m2} answered that they are linked from the intern overview, which is the page to read first"
      ]
    }
  ],
  pages: [
    { title: "Intern overview: read first", kind: "reference", topic: "overview", purpose: "the intern programme, and what every new hire should read first" },
    { title: "Intern milestones", kind: "reference", topic: "milestones", purpose: "the four milestones of the intern programme" },
    { title: "Intern workflow guides", kind: "howto", topic: "workflow", purpose: "make your first change with the team workflow" },
    { title: "First-week checklist for interns", kind: "howto", topic: "firstweek", purpose: "get set up in your first week" },
    { title: "Intern mentor list", kind: "reference", topic: "mentors", purpose: "the mentors for this cohort" },
    { title: "Intern project brief", kind: "reference", topic: "projects", purpose: "how intern projects are chosen and run" },
    { title: "Code review basics for interns", kind: "howto", topic: "workflow", purpose: "get your first pull request reviewed" },
    { title: "Intern demo day guide", kind: "howto", topic: "demo", purpose: "prepare your demo day talk" },
    { title: "Intern questions and answers", kind: "reference", topic: "questions", purpose: "the questions interns ask most" }
  ],
  files: [
    { title: "Intern welcome guide", type: "doc", kind: "guide", topic: "firstweek", status: "final", purpose: "what to do in your first week" },
    { title: "Intern project ideas", type: "doc", kind: "brief", topic: "projects", status: "final", purpose: "project ideas for this cohort" },
    {
      title: "Intern milestone tracker", type: "sheet", topic: "milestones", status: "final",
      rows: [
        "Week one, laptop ready and first pull request merged, owner {i1}",
        "Week four, project plan agreed with the mentor, owner {i2}",
        "Week eight, demo to the team, owner {i3}",
        "Week twelve, company demo day, owner {i4}"
      ]
    }
  ],
  channels: [
    { name: "intern-cohort", topics: ["overview", "firstweek", "mentors"], visibility: "public" },
    { name: "intern-questions", topics: ["questions", "workflow"], visibility: "public" },
    { name: "intern-projects", topics: ["projects", "demo", "milestones"], visibility: "public" }
  ]
};
