import type { Bank } from "../types.js";

export const PLAT: Bank = {
  key: "PLAT",
  name: "Build pipeline upgrade",
  project: true,
  owners: ["platform", "sre"],
  tier: "internal",
  roles: {
    lead: ["platform", "eng-leads"], lead2: ["platform", "eng-leads"], e1: ["platform"], e2: ["platform"],
    e3: ["platform"], e4: ["platform"], s1: ["sre"], s2: ["sre"], f1: ["finance"]
  },
  fileOwner: "e1",
  goal: "every build job runs on the new runner pool with a shared cache, and the median build finishes in under 12 minutes",
  status: [
    "62 of 80 build jobs now run on the new runner pool",
    "the median build time is down from 18 to 11 minutes",
    "the shared cache serves 81% of build steps, up from 64%"
  ],
  topics: [
    {
      id: "overview", name: "build pipeline upgrade",
      facts: [
        "62 of 80 build jobs now run on the new runner pool",
        "the median build time is down from 18 to 11 minutes",
        "the flaky test rate is below 1% of runs",
        "the second rack still waits on a host order",
        "the upgrade finishes when the iOS and Android packaging jobs move"
      ]
    },
    {
      id: "runners", name: "runner pool",
      facts: [
        "the new runner pool has 56 hosts across two racks",
        "the first rack carries 32 runners and the second rack will add 24 more",
        "62 of 80 build jobs run on the new pool and 18 still use the old one",
        "the 18 remaining jobs are the iOS and Android packaging jobs",
        "the host order for the second rack waits on finance approval",
        "jobs move in groups of ten, and each group runs a full night before the next one moves",
        "each runner on the new pool has 16 cores and 64 GB of memory",
        "the old pool runs on 70 hosts that are three years past their support date",
        "a job move is reversed if its median build time grows by more than 10%",
        "runner labels decide which jobs each rack accepts"
      ],
      steps: [
        "check the queue time panel on the build dashboard",
        "pause new job moves if any job waits more than 5 minutes for a runner",
        "add hosts from the spare pool before moving the next group"
      ],
      question: [
        "Can the iOS jobs move before the second rack is in place?",
        "{s1} answered that they need macOS hosts, so they wait for the second rack"
      ],
      risk: "the host order could slip by two weeks if finance approval waits for the budget review",
      decision: "jobs move in groups of ten, and each group runs a full night before the next one moves"
    },
    {
      id: "cache", name: "build cache",
      facts: [
        "the shared cache serves 81% of build steps, up from 64% before the upgrade",
        "the cache warm-up takes 11 minutes and runs before the nightly builds",
        "cache keys include the lockfile hash, so a dependency bump starts a fresh entry",
        "fork builds may read from the shared cache but never write to it",
        "only builds on the main branch write to the shared cache"
      ],
      steps: [
        "find the job on the cache panel of the build dashboard",
        "compare its hit rate with the week before",
        "clear the job's cache entry if its hit rate drops below 50%"
      ],
      question: [
        "Can the cache warm-up run before the nightly builds?",
        "{s2} confirmed that the warm-up takes 11 minutes, so it fits before 01:00"
      ],
      risk: "a bad cache entry could spread a broken build to every branch within an hour",
      decision: "one shared cache serves every branch, and only the main branch writes to it"
    },
    {
      id: "flaky", name: "flaky tests",
      facts: [
        "the flaky test rate dropped from 3.1% to 0.9% of runs",
        "a test moves to quarantine after three failures in a row on the main branch",
        "every quarantined test gets an owner within one working day",
        "the weekly flaky review lists 14 quarantined tests",
        "the team that owns a folder owns its quarantined tests"
      ],
      steps: [
        "open the flaky test dashboard and sort by failures this week",
        "fix the test or agree a date with its owner",
        "release the test from quarantine after ten green runs"
      ],
      question: [
        "Who owns a quarantined test when its author has left?",
        "{lead} answered that the team that owns the folder takes it"
      ],
      risk: "quarantine could hide a real fault if nobody reads the list each week",
      decision: "a test is quarantined after three failures in a row on the main branch"
    },
    {
      id: "queue", name: "merge queue",
      facts: [
        "the merge queue will test up to 6 pull requests in one batch",
        "the average wait in the merge queue is 9 minutes",
        "a failed batch is split in half until the failing pull request is found",
        "an urgent label lets a fix skip the batch and run alone"
      ],
      question: [
        "Does batching slow down a single urgent fix?",
        "{e1} answered that an urgent label skips the batch and runs alone"
      ],
      risk: "large batches could hide which pull request broke the build",
      decision: "the merge queue batches up to six pull requests, and urgent fixes run alone"
    },
    {
      id: "shards", name: "test sharding",
      facts: [
        "the backend test suite runs in 8 shards balanced by recorded duration",
        "no shard runs longer than 6 minutes on the new pool",
        "the 40 slowest integration tests are moving into their own nightly job",
        "the pull request pipeline takes 11 minutes at the median"
      ],
      decision: "the slowest integration tests run nightly instead of on every pull request"
    },
    {
      id: "images", name: "runner image",
      facts: [
        "the build container base image is pinned and rebuilt every Monday",
        "each new runner image goes to one canary host before the rest",
        "common Gradle dependencies are baked into the runner image",
        "Android builds now download less than 200 MB per run",
        "a runner disk that passes 85% full slows every job on that host"
      ],
      steps: [
        "check which runner reports a full disk",
        "run the cleanup job on that runner",
        "take the runner out of the pool if its disk fills again within a day"
      ],
      risk: "a broken runner image could stop every build if it skipped the canary host"
    },
    {
      id: "artifacts", name: "artifact store",
      facts: [
        "build artifacts older than 30 days are deleted from the artifact store",
        "the artifact store holds 3.8 TB, down from 5.1 TB",
        "release artifacts are kept for a year",
        "pull request builds keep their artifacts for 30 days"
      ]
    },
    {
      id: "costs", name: "CI costs",
      facts: [
        "the monthly CI budget is 410 thousand runner minutes",
        "each team sees its share of runner minutes on the dashboard every Monday",
        "an alert goes to the team lead at 80% of the monthly budget",
        "the new pool costs 22% less per build than the old pool"
      ],
      question: [
        "Will teams be charged for their runner minutes?",
        "{f1} answered that minutes are shown per team but not charged this year"
      ]
    },
    {
      id: "dashboard", name: "build dashboard",
      facts: [
        "the build dashboard shows the queue time and duration of every job",
        "the slowest stage of each job is highlighted in the duration view",
        "queue time alerts page the platform on-call engineer after 5 minutes"
      ],
      steps: [
        "open the build dashboard and pick a job",
        "check its queue time, cache hit rate and duration",
        "open the slowest stage to see where the time goes"
      ]
    },
    {
      id: "hygiene", name: "pipeline hygiene",
      facts: [
        "37 pipeline variables are no longer read by any job",
        "the old shell build scripts are moving into an archive folder",
        "runner registration tokens rotate every 30 days",
        "release tags are created by the pipeline instead of by hand"
      ]
    }
  ],
  issues: [
    { topic: "runners", summary: "Add runners to the second rack", what: "adds 24 runners to the second rack for the last 18 build jobs", acceptance: "all 80 jobs run on the new pool for a full week, and the old pool is drained", status: "blocked", blockedBy: "waits on finance approval for the host order" },
    { topic: "cache", summary: "Warm the shared cache before nightly builds", what: "starts the cache warm-up 40 minutes before the nightly builds", acceptance: "the first nightly build reads at least 80% of its steps from the cache", status: "done" },
    { topic: "flaky", summary: "Quarantine a test after three failures", what: "moves a test to quarantine after three failures in a row on the main branch", acceptance: "every quarantined test has an owner within one working day", status: "done" },
    { topic: "runners", summary: "Move the Android packaging jobs", what: "moves the 9 Android packaging jobs to the new runner pool", acceptance: "Android release builds pass three nights in a row on the new pool", status: "in progress" },
    { topic: "runners", summary: "Move the iOS packaging jobs", what: "moves the 9 iOS packaging jobs once the second rack is ready", acceptance: "iOS release builds pass three nights in a row on the new pool", status: "open" },
    { topic: "queue", summary: "Batch pull requests in the merge queue", what: "lets the merge queue test up to 6 pull requests in one batch", acceptance: "the average wait in the queue stays under 10 minutes for two weeks", status: "in review" },
    { topic: "shards", summary: "Shard the backend test suite", what: "splits the backend test suite into 8 shards by recorded duration", acceptance: "no shard runs longer than 6 minutes on the new pool", status: "done" },
    { topic: "images", summary: "Pin the base image for build containers", what: "pins the build container base image and rebuilds it every Monday", acceptance: "two builds a week apart produce the same image digest", status: "done" },
    { topic: "dashboard", summary: "Show the cache hit rate per job", what: "adds the cache hit rate of each job to the build dashboard", acceptance: "the dashboard shows a hit rate for all 80 jobs", status: "in progress" },
    { topic: "artifacts", summary: "Expire old build artifacts", what: "deletes build artifacts older than 30 days from the artifact store", acceptance: "the store stays under 4 TB for four weeks in a row", status: "done" },
    { topic: "hygiene", summary: "Retry steps that fail on network timeouts", what: "retries a build step once when it fails on a network timeout", acceptance: "timeout failures drop below 1% of builds", status: "in progress" },
    { topic: "runners", summary: "Move the docs site build", what: "moves the documentation site build to the new pool", acceptance: "the docs site publishes from the new pool for two weeks", status: "done" },
    { topic: "costs", summary: "Show runner minutes per team", what: "adds a monthly runner minutes budget per team with an alert at 80%", acceptance: "each team sees its usage on the dashboard every Monday", status: "in review" },
    { topic: "runners", summary: "Remove the old runner autoscaler", what: "removes the autoscaler that served the old pool", acceptance: "no job references the old autoscaler for a week", status: "blocked", blockedBy: "waits until the old pool is drained" },
    { topic: "images", summary: "Cache Gradle dependencies on the runner image", what: "bakes common Gradle dependencies into the runner image", acceptance: "Android builds download less than 200 MB per run", status: "done" },
    { topic: "shards", summary: "Split slow integration tests", what: "moves the 40 slowest integration tests into their own nightly job", acceptance: "the pull request pipeline drops under 12 minutes at the median", status: "in progress" },
    { topic: "dashboard", summary: "Alert on runner queue time", what: "alerts the on-call engineer when jobs wait more than 5 minutes for a runner", acceptance: "the alert fires in a test and pages the right rota", status: "in review" },
    { topic: "runners", summary: "Document the runner pool layout", what: "writes up how the two racks, labels and pools fit together", acceptance: "a new engineer finds the right label for a job in one read", status: "open" },
    { topic: "hygiene", summary: "Rotate runner registration tokens", what: "rotates the runner registration tokens every 30 days", acceptance: "no runner uses a token older than 30 days", status: "in progress" },
    { topic: "cache", summary: "Fix the cache key for monorepo builds", what: "adds the lockfile hash to the cache key", acceptance: "cache hits stay above 75% after a dependency bump", status: "done" },
    { topic: "runners", summary: "Move the frontend lint jobs", what: "moves the 12 frontend lint jobs to the new pool", acceptance: "lint jobs finish in under 3 minutes on the new pool", status: "in progress" },
    { topic: "flaky", summary: "Build a flaky test dashboard", what: "lists flaky tests by failure count and owner", acceptance: "the weekly review uses the dashboard instead of a spreadsheet", status: "in review" },
    { topic: "runners", summary: "Drain the old pool on weekends", what: "drains the old pool on weekends to save hosts", acceptance: "the old pool runs no weekend jobs for two weeks", status: "open" },
    { topic: "queue", summary: "Run smoke tests on every merge", what: "runs a 4-minute smoke suite after each merge to the main branch", acceptance: "a failed smoke run stops the next deploy", status: "in progress" },
    { topic: "images", summary: "Add disk cleanup to runners", what: "cleans the runner disk when it passes 85% full", acceptance: "no build fails on a full disk for four weeks", status: "open" },
    { topic: "dashboard", summary: "Measure build time per stage", what: "records the duration of every build stage", acceptance: "the dashboard shows the slowest stage of each job", status: "in progress" },
    { topic: "hygiene", summary: "Move release tagging into the pipeline", what: "creates release tags from the pipeline instead of by hand", acceptance: "three releases in a row are tagged by the pipeline", status: "done" },
    { topic: "queue", summary: "Limit parallel jobs per branch", what: "limits each branch to 4 parallel jobs", acceptance: "queue time stays under 5 minutes during the morning peak", status: "open" },
    { topic: "hygiene", summary: "Archive the old build scripts", what: "moves the old shell build scripts into an archive folder", acceptance: "no active job calls an archived script", status: "in progress" },
    { topic: "cache", summary: "Share the cache with fork builds", what: "lets fork builds read the shared cache without writing to it", acceptance: "fork builds reach a 60% cache hit rate", status: "in review" },
    { topic: "images", summary: "Upgrade the runner agent", what: "upgrades the runner agent on all 56 hosts", acceptance: "every host reports the new agent version", status: "blocked", blockedBy: "waits for the agent maintainers to publish a fixed build" },
    { topic: "costs", summary: "Track the cost per build", what: "estimates the host cost of each build from its runner minutes", acceptance: "the monthly cost view matches the finance export within 5%", status: "open" },
    { topic: "cache", summary: "Retire the nightly full rebuild", what: "replaces the nightly full rebuild with cached incremental builds", acceptance: "nightly builds take under 25 minutes", status: "in progress" },
    { topic: "images", summary: "Test each runner image on a canary host", what: "rolls each new runner image to one canary host first", acceptance: "a broken image never reaches more than one host", status: "done" },
    { topic: "hygiene", summary: "Write the pipeline style guide", what: "sets naming and layout rules for pipeline files", acceptance: "new pipelines pass the lint check on the first try", status: "open" },
    { topic: "hygiene", summary: "Clean up unused pipeline variables", what: "removes 37 pipeline variables that no job reads", acceptance: "the variable list keeps only the ones in use", status: "in progress" }
  ],
  masterIssues: [1, 4, 5, 6],
  pages: [
    { title: "Runner pool design", kind: "design", topic: "runners", purpose: "how the two racks and the runner labels serve every build job" },
    { title: "Build cache design", kind: "design", topic: "cache", purpose: "how the shared build cache is filled, keyed and cleared" },
    { title: "Decision record: one shared cache for every branch", kind: "decision", topic: "cache" },
    { title: "Decision record: automatic quarantine for flaky tests", kind: "decision", topic: "flaky" },
    { title: "Decision record: batching in the merge queue", kind: "decision", topic: "queue" },
    { title: "Playbook: runner queue backlog", kind: "playbook", topic: "runners", purpose: "jobs wait more than 5 minutes for a runner" },
    { title: "Playbook: cache hit rate drop", kind: "playbook", topic: "cache", purpose: "a job's cache hit rate falls below 50%" },
    { title: "Playbook: full runner disk", kind: "playbook", topic: "images", purpose: "a build fails because a runner disk is full" },
    { title: "Pipeline sync: rack capacity", kind: "meeting", topic: "runners" },
    { title: "Pipeline sync: merge queue batching", kind: "meeting", topic: "queue" },
    { title: "Pipeline sync: flaky test review", kind: "meeting", topic: "flaky" },
    { title: "How to move a job to the new runner pool", kind: "howto", topic: "runners", purpose: "move a build job to the new runner pool" },
    { title: "How to read the build dashboard", kind: "howto", topic: "dashboard", purpose: "read the build dashboard" },
    { title: "How to release a test from quarantine", kind: "howto", topic: "flaky", purpose: "release a test from quarantine" },
    { title: "Runner labels and pools", kind: "reference", topic: "runners", purpose: "the runner labels, racks and pools" },
    { title: "Build time budget", kind: "design", topic: "shards", purpose: "how the pull request pipeline stays under 12 minutes" },
    { title: "Retrospective: the first 40 jobs", kind: "meeting", topic: "runners", status: "draft" }
  ],
  files: [
    { title: "Runner pool rollout plan", type: "doc", kind: "plan", topic: "runners", status: "final", master: true, purpose: "the order in which the 80 build jobs move to the new runner pool", say: ["62 of 80 build jobs run on the new pool and 18 still use the old one.", "The new runner pool has 56 hosts across two racks."] },
    { title: "Build cache proposal", type: "doc", kind: "proposal", topic: "cache", status: "final", master: true, purpose: "one shared build cache for every branch" },
    { title: "Flaky test policy", type: "doc", kind: "policy", topic: "flaky", status: "final", purpose: "how flaky tests are quarantined and released" },
    { title: "Merge queue batching spec", type: "doc", kind: "spec", topic: "queue", status: "in review", purpose: "how the merge queue batches pull requests" },
    { title: "Test sharding spec", type: "doc", kind: "spec", topic: "shards", status: "final", purpose: "how the backend suite is split into shards" },
    { title: "Runner image guide", type: "doc", kind: "guide", topic: "images", status: "final", purpose: "how runner disks are kept clean" },
    { title: "Artifact retention proposal", type: "doc", kind: "proposal", topic: "artifacts", status: "final", purpose: "keeping build artifacts for 30 days and releases for a year" },
    { title: "Runner minutes budget proposal", type: "doc", kind: "proposal", topic: "costs", status: "draft", purpose: "a monthly runner minutes budget for each team" },
    { title: "Build dashboard guide", type: "doc", kind: "guide", topic: "dashboard", status: "final", purpose: "how to find the slowest stage of a build" },
    { title: "Pipeline hygiene checklist", type: "doc", kind: "checklist", topic: "hygiene", status: "in review", purpose: "keeping pipeline files and variables tidy" },
    { title: "Second rack capacity proposal", type: "doc", kind: "proposal", topic: "runners", status: "in review", master: true, purpose: "24 more runners on a second rack for the last 18 jobs" },
    { title: "Canary host rules", type: "doc", kind: "spec", topic: "images", status: "final", purpose: "how a new runner image reaches the canary host first" },
    {
      title: "Runner minutes by team", type: "sheet", topic: "costs", status: "final", master: true,
      rows: [
        "Team platform, 128 thousand minutes, 31% of the budget, owner {e1}",
        "Team mobile, 96 thousand minutes, 23% of the budget, owner {e2}",
        "Team data, 74 thousand minutes, 18% of the budget, owner {e3}",
        "Team product, 41 thousand minutes, 10% of the budget, owner {e4}",
        "Shared jobs, 71 thousand minutes, 18% of the budget, owner {s1}"
      ]
    },
    {
      title: "Job move tracker", type: "sheet", topic: "runners", status: "final", master: true,
      rows: [
        "Group backend, 24 jobs, moved, owner {e1}",
        "Group frontend build, 12 jobs, moved, owner {e3}",
        "Group docs and tools, 26 jobs, moved, owner {e4}",
        "Group Android packaging, 9 jobs, moving, owner {e2}",
        "Group iOS packaging, 9 jobs, waiting on the second rack, owner {e2}"
      ]
    },
    {
      title: "Flaky test list", type: "sheet", topic: "flaky", status: "final",
      rows: [
        "Test checkout_totals_rounding, 7 failures, quarantined, owner {e3}",
        "Test search_suggest_timeout, 5 failures, quarantined, owner {e1}",
        "Test profile_avatar_upload, 4 failures, fixed this week, owner {e4}",
        "Test export_csv_large_file, 3 failures, quarantined, owner {e2}"
      ]
    },
    {
      title: "Cache hit rates by job", type: "sheet", topic: "cache", status: "final",
      rows: [
        "Job backend build, 88% hit rate, up from 70%",
        "Job frontend build, 84% hit rate, up from 61%",
        "Job Android packaging, 69% hit rate, up from 52%",
        "Job docs site, 92% hit rate, up from 80%"
      ]
    },
    {
      title: "Runner hosts by rack", type: "sheet", topic: "runners", status: "final",
      rows: [
        "Rack one, 32 runners, Linux, in service since the first move",
        "Rack two, 24 runners, macOS and Linux, waiting on the host order",
        "Spare pool, 6 runners, Linux, kept on standby for peaks",
        "Canary host, 1 runner, Linux, first to get each new image"
      ]
    },
    {
      title: "Build time by stage", type: "sheet", topic: "dashboard", status: "in review",
      rows: [
        "Stage checkout, 0.6 minutes at the median",
        "Stage dependencies, 2.1 minutes at the median",
        "Stage compile, 4.2 minutes at the median",
        "Stage tests, 3.4 minutes at the median",
        "Stage packaging, 0.9 minutes at the median"
      ]
    },
    {
      title: "Artifact store usage", type: "sheet", topic: "artifacts", status: "final",
      rows: [
        "Folder release builds, 1.4 TB, kept for a year",
        "Folder pull request builds, 1.1 TB, kept for 30 days",
        "Folder nightly builds, 0.9 TB, kept for 30 days",
        "Folder test logs, 0.4 TB, kept for 30 days"
      ]
    },
    { title: "Pipeline upgrade review slides", type: "slides", topic: "overview", status: "final", master: true, purpose: "where the build pipeline upgrade stands" },
    { title: "Runner pool status slides", type: "slides", topic: "runners", status: "final", purpose: "the runner pool after the first 62 job moves" },
    { title: "Cache results slides", type: "slides", topic: "cache", status: "final", purpose: "what the shared cache changed for build times" },
    { title: "Flaky test review slides", type: "slides", topic: "flaky", status: "in review", purpose: "the flaky test rate and the quarantine list" },
    { title: "Runner minutes slides", type: "slides", topic: "costs", status: "draft", purpose: "runner minutes and cost per team" },
    { title: "Merge queue slides", type: "slides", topic: "queue", status: "final", purpose: "how batching changed the wait in the merge queue" },
    { title: "Exported build metrics summary", type: "pdf", kind: "summary", topic: "shards", status: "final", purpose: "build times and shard durations for the last four weeks" },
    { title: "Exported runner capacity summary", type: "pdf", kind: "summary", topic: "runners", status: "final", purpose: "runner capacity on both racks" }
  ],
  channels: [
    { name: "plat-runners", status: "62 of 80 build jobs run on the new pool, and the 9 Android packaging jobs are moving now",
      topics: ["runners"], visibility: "public", agreements: [0, 3] },
    { name: "plat-build-cache", status: "the shared cache serves 81% of build steps, and cached incremental builds are under way",
      topics: ["cache"], visibility: "public" },
    { name: "plat-flaky-tests", status: "the flaky test rate is down to 0.9% of runs, with 14 tests in quarantine",
      topics: ["flaky"], visibility: "public", agreements: [1] },
    { name: "plat-merge-queue", status: "the backend suite runs in 8 shards, and merge queue batching is in review",
      topics: ["queue", "shards"], visibility: "public", agreements: [2] },
    { name: "plat-artifacts", status: "the artifact store is down to 3.8 TB after the 30-day cleanup",
      topics: ["artifacts", "hygiene"], visibility: "public" },
    { name: "plat-images", status: "Android builds download less than 200 MB per run since Gradle dependencies moved into the runner image",
      topics: ["images"], visibility: "public" },
    { name: "plat-ci-costs", status: "the new pool costs 22% less per build, and team budgets are in review",
      topics: ["costs"], visibility: "public" },
    { name: "plat-dashboard", status: "queue time and duration are on the build dashboard, and the cache hit rate is being added",
      topics: ["dashboard"], visibility: "public" },
    {
      name: "plat-leads", status: "62 of 80 jobs have moved, and the second rack still waits on finance approval",
      topics: ["runners", "costs"], visibility: "private",
      access: { groups: ["platform"], members: ["lead", "lead2", "s1", "ravi", "maya"] }
    },
    { name: "plat-standup", status: "62 of 80 build jobs are on the new pool, and the cache serves 81% of build steps",
      topics: ["runners", "cache", "flaky", "hygiene"], visibility: "public" }
  ],
  agreements: [
    "Agreed: {e2} moves the iOS jobs after the capacity fix.",
    "Decision: a test is quarantined after three failures in a row.",
    "Let's go with batches of six in the merge queue for now.",
    "Approved: {s1} drains the old pool on weekends from next week."
  ],
  trackedBy: 5,
  copies: {
    superseded: [
      { title: "Runner pool rollout plan", older: [["62 of 80", "40 of 80"], ["56 hosts", "48 hosts"], ["18 still", "40 still"]] },
      { title: "Runner minutes by team", older: [["128 thousand", "141 thousand"], ["96 thousand", "88 thousand"], ["74 thousand", "79 thousand"]] }
    ],
    near: [{ of: "Build cache proposal", title: "Cache warm-up proposal for nightly builds", changes: [] }]
  }
};
