import type { Bank } from "../types.js";

export const DATA: Bank = {
  key: "DATA",
  name: "Customer data warehouse",
  project: true,
  owners: ["data", "product"],
  tier: "internal",
  roles: {
    lead: ["data", "eng-leads"], pm: ["product"], a1: ["data"], a2: ["data"], a3: ["data"], a4: ["data"],
    r1: ["risk"]
  },
  fileOwner: "a1",
  goal: "every product team reads customer metrics from one warehouse, with data no older than two hours",
  status: [
    "21 of 30 ingestion jobs now load into the new warehouse",
    "26 of 30 main tables meet the two-hour freshness target",
    "14 of 20 product dashboards read from the new warehouse"
  ],
  topics: [
    {
      id: "ingestion", name: "ingestion jobs",
      facts: [
        "21 of 30 ingestion jobs load into the new warehouse",
        "each ingestion job writes to a staging table before the main table",
        "the event stream job loads 48 million rows a day",
        "a failed load is retried three times before it pages the data on-call engineer"
      ],
      steps: [
        "find the failed job on the ingestion dashboard",
        "read the error from the last retry",
        "rerun the job from its staging table once the source is back"
      ],
      question: [
        "Can the event stream job load every 15 minutes?",
        "{a1} answered that it can once the staging table is partitioned by hour"
      ],
      risk: "the event stream job could miss its two-hour target during a nightly backfill",
      decision: "every ingestion job writes to a staging table before the main table"
    },
    {
      id: "quality", name: "data quality checks",
      facts: [
        "128 quality checks run after every load",
        "a failed check stops the linked dashboards from refreshing",
        "null checks caught three broken loads in the last four weeks",
        "nightly row counts are compared with each source system",
        "each quality check has an owner and a severity",
        "a warning check posts in the quality channel without stopping anything",
        "most failed checks trace back to a late export from a source system"
      ],
      steps: [
        "write the check as a query that returns the failing rows",
        "add it to the check catalogue with an owner",
        "run it against last night's load before you merge it"
      ],
      question: [
        "Should a failed check really stop the dashboards?",
        "{lead} answered yes, because a stale number is safer than a wrong one"
      ],
      decision: "a failed quality check stops the linked dashboards from refreshing"
    },
    {
      id: "dashboards", name: "dashboards",
      facts: [
        "14 of 20 product dashboards read from the new warehouse",
        "the churn dashboard refreshes every hour",
        "dashboard owners sign off before an old version is removed",
        "the revenue dashboard waits on a finance sign-off"
      ]
    },
    {
      id: "tables", name: "warehouse tables",
      facts: [
        "the customer table holds one row per account with 42 columns",
        "main tables are partitioned by day and clustered by account",
        "new column names follow the naming guide",
        "26 of 30 main tables meet the two-hour freshness target"
      ],
      decision: "the customer table is partitioned by day and clustered by account"
    },
    {
      id: "backfills", name: "backfills",
      facts: [
        "the two-year backfill of events finished in six nights",
        "backfills run only between 22:00 and 06:00",
        "a backfill writes to a copy of the table and swaps it in at the end",
        "the support tickets backfill covers three years of history"
      ],
      risk: "a long backfill could overlap working hours and slow the dashboards",
      decision: "backfills run only between 22:00 and 06:00"
    },
    {
      id: "costs", name: "query costs",
      facts: [
        "the average dashboard query scans 1.2 GB",
        "query costs fell 35% after partitioning",
        "a query that scans more than 50 GB needs approval",
        "tables nobody queried in 90 days are dropped",
        "the five most expensive queries make up half of the monthly bill",
        "each team sees its query costs in a weekly summary"
      ],
      steps: [
        "estimate the scan size with a dry run",
        "ask the table owner for approval in the costs channel",
        "run the query outside working hours if it scans more than 200 GB"
      ]
    },
    {
      id: "schema", name: "schema changes",
      facts: [
        "schema changes go through a pull request with a data owner review",
        "a breaking change is announced two weeks before it applies",
        "new columns are added at the end of a table",
        "renamed columns keep an alias for two weeks"
      ]
    },
    {
      id: "freshness", name: "freshness",
      facts: [
        "freshness is measured as the age of the newest row",
        "the two-hour target applies to the 30 main tables",
        "a freshness alert goes to the table owner after three hours",
        "the team dashboard will show freshness for every main table",
        "the billing events table is the stalest, at about 9 hours",
        "the support tickets table runs about three hours behind on a typical day",
        "freshness is checked every 15 minutes"
      ],
      steps: [
        "open the freshness view and find the stale table",
        "check whether its ingestion job failed or ran late",
        "post the expected refresh time in the dashboards channel"
      ]
    },
    {
      id: "churn", name: "churn model",
      facts: [
        "the churn model scores every account each night",
        "churn model inputs come from the customer and activity tables",
        "risk analysts review the model features once a month",
        "nightly churn scores match the old model within 1%"
      ],
      question: [
        "Who signs off the churn model features?",
        "{r1} answered that the risk team signs them off at its monthly review"
      ]
    }
  ],
  issues: [
    { topic: "ingestion", summary: "Partition the event staging table by hour", what: "partitions the event staging table by hour so loads can run every 15 minutes", acceptance: "the event stream job loads every 15 minutes for a week", status: "in progress" },
    { topic: "ingestion", summary: "Move the billing events job", what: "moves the billing events job to the new warehouse", acceptance: "billing events reach the warehouse within two hours", status: "blocked", blockedBy: "waits on read access to the billing source" },
    { topic: "quality", summary: "Stop dashboards when a check fails", what: "stops dashboard refreshes when a quality check fails", acceptance: "a failed check holds every linked dashboard", status: "done" },
    { topic: "quality", summary: "Compare row counts with each source", what: "compares nightly row counts with each source system", acceptance: "a mismatch above 0.5% opens a ticket", status: "done" },
    { topic: "dashboards", summary: "Move the churn dashboard", what: "moves the churn dashboard to the new warehouse", acceptance: "the churn dashboard refreshes every hour from the new warehouse", status: "done" },
    { topic: "dashboards", summary: "Move the revenue dashboard", what: "moves the revenue dashboard to the new warehouse", acceptance: "finance signs off the new revenue numbers", status: "in review" },
    { topic: "tables", summary: "Partition the customer table by day", what: "partitions the customer table by day and clusters it by account", acceptance: "account lookups scan less than 1 GB", status: "done" },
    { topic: "tables", summary: "Apply the naming guide to old columns", what: "renames 64 old columns to follow the naming guide", acceptance: "every column in the main tables follows the naming guide", status: "in progress" },
    { topic: "backfills", summary: "Backfill two years of events", what: "backfills two years of events into the new warehouse", acceptance: "row counts match the source for every day", status: "done" },
    { topic: "backfills", summary: "Limit backfills to night hours", what: "limits backfills to the hours between 22:00 and 06:00", acceptance: "no backfill runs during working hours for four weeks", status: "done" },
    { topic: "costs", summary: "Require approval for large queries", what: "requires approval for queries that scan more than 50 GB", acceptance: "large queries show an approval prompt", status: "in review" },
    { topic: "costs", summary: "Show query cost per dashboard", what: "shows the scan size of each dashboard query", acceptance: "every dashboard shows its average scan size", status: "in progress" },
    { topic: "schema", summary: "Add a data owner review to schema changes", what: "adds a required data owner review to schema change pull requests", acceptance: "no schema change merges without an owner review", status: "done" },
    { topic: "schema", summary: "Announce breaking schema changes", what: "posts breaking schema changes two weeks before they apply", acceptance: "every breaking change has an announcement two weeks ahead", status: "open" },
    { topic: "freshness", summary: "Alert table owners on stale data", what: "alerts the table owner when the newest row is older than three hours", acceptance: "a test alert reaches the owner", status: "done" },
    { topic: "freshness", summary: "Measure freshness for the main tables", what: "measures the age of the newest row in each of the 30 main tables", acceptance: "the freshness view covers all 30 main tables", status: "done" },
    { topic: "ingestion", summary: "Move the support tickets job", what: "moves the support tickets job to the new warehouse", acceptance: "ticket data reaches the warehouse within two hours", status: "open" },
    { topic: "ingestion", summary: "Retry failed loads three times", what: "retries a failed load three times before paging the data on-call engineer", acceptance: "fewer than two loads a week page the on-call engineer", status: "done" },
    { topic: "dashboards", summary: "Move the activation dashboard", what: "moves the activation dashboard to the new warehouse", acceptance: "the product team signs off the activation numbers", status: "in progress" },
    { topic: "tables", summary: "Describe every customer table column", what: "adds a description and an owner to every column of the customer table", acceptance: "each of the 42 columns has a description and an owner", status: "open" },
    { topic: "churn", summary: "Score churn on the new tables", what: "moves the churn model inputs to the new customer and activity tables", acceptance: "nightly scores match the old model within 1%", status: "in review" },
    { topic: "churn", summary: "Review churn model features with risk", what: "reviews the churn model features with the risk analysts", acceptance: "the risk team signs off the feature list", status: "blocked", blockedBy: "waits for the risk team's monthly review slot" },
    { topic: "costs", summary: "Drop tables nobody queries", what: "drops tables that nobody queried in 90 days", acceptance: "storage falls by at least 15%", status: "open" },
    { topic: "quality", summary: "Add null checks to the event tables", what: "adds null checks to the 12 event tables", acceptance: "a broken load fails its null check in a test", status: "done" },
    { topic: "freshness", summary: "Add freshness to the team dashboard", what: "adds the freshness view to the data team dashboard", acceptance: "the team dashboard shows freshness for every main table", status: "in progress" },
    { topic: "dashboards", summary: "Retire the old analytics cluster", what: "shuts down the old analytics cluster after the last dashboard moves", acceptance: "no dashboard reads from the old cluster for two weeks", status: "open" },
    { topic: "backfills", summary: "Backfill the support tickets history", what: "backfills three years of support tickets", acceptance: "ticket counts match the source for every week", status: "open" },
    { topic: "schema", summary: "Write the column naming guide", what: "writes the naming guide for warehouse columns", acceptance: "new tables follow the guide at their first review", status: "done" }
  ],
  masterIssues: [1, 2, 6, 21],
  pages: [
    { title: "Warehouse architecture", kind: "design", topic: "tables", purpose: "how staging tables, main tables and dashboards fit together" },
    { title: "Decision record: staging before main tables", kind: "decision", topic: "ingestion" },
    { title: "Decision record: quality checks stop dashboards", kind: "decision", topic: "quality" },
    { title: "Playbook: failed nightly load", kind: "playbook", topic: "ingestion", purpose: "a nightly load fails after its three retries" },
    { title: "Playbook: stale dashboard", kind: "playbook", topic: "freshness", purpose: "a dashboard shows data older than two hours" },
    { title: "Data sync: dashboard moves", kind: "meeting", topic: "dashboards" },
    { title: "Data sync: backfill planning", kind: "meeting", topic: "backfills" },
    { title: "How to add a quality check", kind: "howto", topic: "quality", purpose: "add a quality check to a main table" },
    { title: "How to request a large query", kind: "howto", topic: "costs", purpose: "request approval for a query that scans more than 50 GB" },
    { title: "Column naming guide", kind: "reference", topic: "tables", purpose: "how warehouse columns are named and described" },
    { title: "Schema change process", kind: "reference", topic: "schema", purpose: "how a schema change is reviewed and announced" },
    { title: "Freshness targets", kind: "design", topic: "freshness", purpose: "the two-hour freshness target and how it is measured" },
    {
      title: "Customer churn model review", kind: "design", topic: "churn", purpose: "the churn model features the risk team reviews",
      access: { groups: ["risk"], restrictTo: ["risk"] }
    },
    { title: "Retrospective: the event backfill", kind: "meeting", topic: "backfills", status: "draft" }
  ],
  files: [
    { title: "Warehouse rollout plan", type: "doc", kind: "plan", topic: "ingestion", status: "final", master: true, purpose: "the order in which ingestion jobs and dashboards move to the new warehouse", say: ["21 of 30 ingestion jobs have moved, including the event stream job with 48 million rows a day."] },
    { title: "Quality check catalogue", type: "doc", kind: "spec", topic: "quality", status: "final", purpose: "the quality checks that run after every load" },
    { title: "Ingestion job guide", type: "doc", kind: "guide", topic: "ingestion", status: "final", purpose: "how to rerun a failed ingestion job" },
    { title: "Backfill plan", type: "doc", kind: "plan", topic: "backfills", status: "final", purpose: "the nightly backfills of events and support tickets" },
    { title: "Query cost proposal", type: "doc", kind: "proposal", topic: "costs", status: "final", purpose: "an approval step for queries that scan more than 50 GB" },
    { title: "Schema change guide", type: "doc", kind: "spec", topic: "schema", status: "final", purpose: "how schema changes are reviewed and announced" },
    { title: "Dashboard move checklist", type: "doc", kind: "checklist", topic: "freshness", status: "in review", master: true, purpose: "moving a dashboard to the new warehouse" },
    { title: "Freshness alert guide", type: "doc", kind: "guide", topic: "freshness", status: "final", purpose: "what to do when a freshness alert fires" },
    { title: "Churn model inputs", type: "doc", kind: "spec", topic: "churn", status: "final", purpose: "the tables and columns the churn model reads" },
    {
      title: "Ingestion job tracker", type: "sheet", topic: "ingestion", status: "final", master: true,
      rows: [
        "Job event stream, 48 million rows a day, moved, owner {a1}",
        "Job accounts, 2 million rows a day, moved, owner {a2}",
        "Job billing events, 6 million rows a day, waiting on read access, owner {a3}",
        "Job support tickets, 90 thousand rows a day, not started, owner {a4}"
      ]
    },
    {
      title: "Dashboard move tracker", type: "sheet", topic: "dashboards", status: "final",
      rows: [
        "Dashboard churn, moved, refreshes every hour, owner {a2}",
        "Dashboard revenue, in review, waiting on the finance sign-off, owner {pm}",
        "Dashboard activation, moving, owner {a3}",
        "Dashboard retention, moved, refreshes every hour, owner {a1}"
      ]
    },
    {
      title: "Table freshness sheet", type: "sheet", topic: "freshness", status: "final",
      rows: [
        "Table customers, newest row 40 minutes old, on target",
        "Table events, newest row 25 minutes old, on target",
        "Table billing events, newest row 9 hours old, off target",
        "Table support tickets, newest row 3 hours old, off target"
      ]
    },
    {
      title: "Query costs by team", type: "sheet", topic: "costs", status: "in review", access: { users: ["c4"] },
      rows: [
        "Team product analytics, 1.4 GB per query, down 41%",
        "Team finance, 2.2 GB per query, down 28%",
        "Team growth, 0.9 GB per query, down 37%",
        "Team support, 0.6 GB per query, down 22%"
      ]
    },
    {
      title: "Quality check results", type: "sheet", topic: "quality", status: "final",
      rows: [
        "Check customers not null, passed 28 nights in a row",
        "Check events row count, failed twice after source delays",
        "Check billing amounts positive, passed every night",
        "Check account ids unique, passed every night"
      ]
    },
    {
      title: "Backfill progress", type: "sheet", topic: "backfills", status: "final",
      rows: [
        "Backfill events, two years, finished in six nights",
        "Backfill accounts, five years, finished in one night",
        "Backfill support tickets, three years, not started",
        "Backfill billing events, one year, waiting on read access"
      ]
    },
    {
      title: "Column inventory", type: "sheet", topic: "tables", status: "draft",
      rows: [
        "Table customers, 42 columns, 38 described",
        "Table events, 17 columns, 17 described",
        "Table accounts, 23 columns, 19 described",
        "Table activity, 12 columns, 9 described"
      ]
    },
    { title: "Warehouse review slides", type: "slides", topic: "tables", status: "final", master: true, purpose: "where the customer data warehouse stands" },
    { title: "Freshness results slides", type: "slides", topic: "freshness", status: "final", purpose: "how fresh the main tables are" },
    { title: "Cost savings slides", type: "slides", topic: "costs", status: "final", purpose: "what partitioning did to query costs" },
    { title: "Dashboard move slides", type: "slides", topic: "dashboards", status: "in review", purpose: "the dashboards moved so far" },
    { title: "Exported quality summary", type: "pdf", kind: "summary", topic: "quality", status: "final", purpose: "quality check results for the last four weeks" },
    { title: "Exported freshness summary", type: "pdf", kind: "summary", topic: "freshness", status: "final", purpose: "freshness for the 30 main tables" }
  ],
  channels: [
    { name: "data-ingestion", status: "21 of 30 ingestion jobs load into the new warehouse, and hourly staging partitions are in progress",
      topics: ["ingestion"], visibility: "public", agreements: [0] },
    { name: "data-quality", status: "128 checks run after every load, and all 12 event tables now have null checks",
      topics: ["quality"], visibility: "public", agreements: [1] },
    { name: "data-dashboards", status: "14 of 20 product dashboards read from the new warehouse, and the revenue dashboard is in review",
      topics: ["dashboards"], visibility: "public" },
    { name: "data-warehouse-tables", status: "26 of 30 main tables meet the freshness target, and 64 old columns are being renamed",
      topics: ["tables", "schema"], visibility: "public", agreements: [3] },
    { name: "data-backfills", status: "the two-year event backfill is finished, and the support tickets backfill is next",
      topics: ["backfills"], visibility: "public", agreements: [2] },
    { name: "data-costs", status: "query costs are down 35% since partitioning, and scan sizes per dashboard are in progress",
      topics: ["costs"], visibility: "public" },
    { name: "data-freshness", status: "freshness is measured for all 30 main tables, and the dashboard view is in progress",
      topics: ["freshness"], visibility: "public" },
    { name: "data-standup", status: "21 of 30 ingestion jobs and 14 of 20 dashboards now use the new warehouse",
      topics: ["ingestion", "quality", "dashboards", "churn"], visibility: "public" }
  ],
  agreements: [
    "Agreed: {a1} partitions the event staging table by hour.",
    "Decision: a failed quality check stops the linked dashboards.",
    "Decided: {a2} runs the next backfill on the weekend.",
    "Let's go with daily partitions for the customer table."
  ],
  trackedBy: 1,
  copies: {
    superseded: [{ title: "Warehouse rollout plan", older: [["21 of 30", "12 of 30"], ["48 million", "31 million"]] }],
    near: [{ of: "Quality check catalogue", title: "Data checks overview", changes: [] }]
  }
};
