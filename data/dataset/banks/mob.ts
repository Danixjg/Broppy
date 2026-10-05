import type { Bank } from "../types.js";

export const MOB: Bank = {
  key: "MOB",
  name: "Mobile app 4.0 release",
  project: true,
  owners: ["mobile", "product", "design"],
  tier: "internal",
  roles: {
    lead: ["mobile", "eng-leads"], pm: ["product"], d1: ["design"], d2: ["design"], e1: ["mobile"], e2: ["mobile"],
    e3: ["mobile"], e4: ["mobile"]
  },
  fileOwner: "pm",
  goal: "version 4.0 reaches every customer through a staged rollout, with a crash-free rate of at least 99.5%",
  status: [
    "the 4.0 release candidate passed store review on Android and waits on review for iOS",
    "the staged rollout sits at 10% of Android users",
    "the crash-free rate on the beta is 99.6%, up from 99.2%"
  ],
  topics: [
    {
      id: "overview", name: "4.0 release",
      facts: [
        "the 4.0 release candidate passed store review on Android and waits on review for iOS",
        "the Android rollout is at 10% of users",
        "the beta crash-free rate is 99.6%",
        "the new home screen and offline mode both ship in 4.0",
        "cold start is under 2 seconds on mid-range phones"
      ]
    },
    {
      id: "privacy", name: "privacy label",
      facts: [
        "the location prompt now asks only while the app is open",
        "the privacy label lists location as used to show nearby pickup points",
        "legal approved the new label text",
        "both stores must show the same label text before the rollout widens"
      ]
    },
    {
      id: "train", name: "release train",
      facts: [
        "a new build leaves the release train every second Thursday",
        "the 4.0 branch was cut after the beta sign-off",
        "hotfixes go out between trains only when the crash-free rate drops below 99%",
        "the release candidate carries 212 merged pull requests",
        "only crash fixes merge after the branch freeze on Tuesday"
      ],
      steps: [
        "check that the beta sign-off is recorded for the build",
        "cut the release branch from the main branch at the agreed commit",
        "post the branch name and the freeze time in the release channel"
      ],
      question: [
        "Can the offline mode fix still make the 4.0 train?",
        "{lead} answered that it can if it merges before the branch freeze on Tuesday"
      ],
      decision: "the release train leaves every second Thursday, with hotfixes in between only for crashes"
    },
    {
      id: "crashes", name: "crash-free rate",
      facts: [
        "the crash-free rate on the beta is 99.6%",
        "the top crash came from image caching on older Android phones",
        "crash alerts reach the team channel within 5 minutes",
        "a release stops if the crash-free rate drops below 99%",
        "crash alerts will name the phone model and its memory"
      ],
      steps: [
        "pause the rollout from the store console",
        "check the top crash on the crash dashboard",
        "ship a hotfix on the next train or roll back to the previous build"
      ],
      question: [
        "Is the image caching crash fixed in the release candidate?",
        "{e2} confirmed that the fix is in the candidate and the crash count is zero on the beta"
      ],
      risk: "a crash spike on older Android phones could stop the rollout at 10%"
    },
    {
      id: "review", name: "store review",
      facts: [
        "the iOS build has been in store review for two days",
        "the Android build passed review on the first try",
        "store screenshots were refreshed for the new home screen",
        "the location privacy label changes in 4.0"
      ],
      steps: [
        "read the reviewer's message in the store console",
        "fix the build or answer the question within one working day",
        "resubmit the build and note the new review time in the release channel"
      ],
      question: [
        "Do we need a new privacy label for 4.0?",
        "{pm} answered that the location label changes, so legal signed off the new text"
      ]
    },
    {
      id: "rollout", name: "staged rollout",
      facts: [
        "the Android rollout went from 1% to 10% after two clean days",
        "the next rollout steps are 25%, 50% and 100% of users",
        "each rollout step waits 48 hours and needs a crash-free rate of 99.5%",
        "the iOS rollout starts at 5% once store review passes",
        "the rollout pauses on its own if crashes double within an hour",
        "release captains raise each step from the store console",
        "the rollout reaches every Android user about ten days after the first step"
      ],
      steps: [
        "check the crash-free rate for the current step",
        "raise the rollout to the next step in the store console",
        "post the new percentage in the release channel"
      ],
      risk: "the iOS rollout could slip if store review asks for another change",
      decision: "each rollout step waits 48 hours and needs a crash-free rate of 99.5%"
    },
    {
      id: "offline", name: "offline mode",
      facts: [
        "offline mode keeps the last 30 days of activity on the phone",
        "sync conflicts resolve in favour of the most recent edit",
        "offline mode is behind a flag for 20% of beta testers",
        "the next build shows when the app last synced and what is waiting to upload",
        "offline edits wait in a queue and upload in the order they were made",
        "photos taken offline upload only on Wi-Fi"
      ],
      decision: "the most recent edit wins a sync conflict"
    },
    {
      id: "home", name: "new home screen",
      facts: [
        "the new home screen puts the three most used actions at the top",
        "usability tests with 12 customers found the new layout faster",
        "dark theme colours were adjusted to meet the contrast guideline",
        "the new home screen ships on both platforms in 4.0"
      ],
      question: [
        "Will the new home screen colours change before the release?",
        "{d1} answered that the colours are final for 4.0"
      ]
    },
    {
      id: "a11y", name: "accessibility",
      facts: [
        "every button on the new home screen has a screen reader label",
        "text scales up to 200% without clipping",
        "the accessibility audit found 9 problems and 7 are fixed",
        "the two open audit findings are on the settings screens"
      ]
    },
    {
      id: "beta", name: "beta programme",
      facts: [
        "the beta has 1,840 testers across both platforms",
        "beta feedback is triaged every Monday",
        "the beta sign-off needs two weeks without a new top crash",
        "the beta needs 300 testers with phones older than four years"
      ]
    },
    {
      id: "perf", name: "app performance",
      facts: [
        "cold start time dropped from 2.8 to 1.9 seconds",
        "the app grew by 4 MB because of the new fonts",
        "scrolling stays at 60 frames per second on mid-range phones",
        "three startup tasks no longer block the first screen"
      ]
    }
  ],
  issues: [
    { topic: "rollout", summary: "Stage the Android rollout", what: "moves the Android rollout through 25%, 50% and 100% of users", acceptance: "each step holds for 48 hours with a crash-free rate of at least 99.5%", status: "in progress" },
    { topic: "crashes", summary: "Fix the image caching crash on older phones", what: "fixes the image caching crash on Android phones with less than 3 GB of memory", acceptance: "no image caching crash appears on the beta for a week", status: "done" },
    { topic: "review", summary: "Answer the iOS store review questions", what: "answers the store review questions about the account deletion flow", acceptance: "the iOS build passes store review", status: "blocked", blockedBy: "waits on the store review team to reply" },
    { topic: "train", summary: "Cut the 4.0 release branch", what: "cuts the 4.0 branch after the beta sign-off", acceptance: "the branch builds green on both platforms", status: "done" },
    { topic: "offline", summary: "Resolve offline sync conflicts", what: "resolves sync conflicts in favour of the most recent edit", acceptance: "no edit is lost in a test with 500 offline changes", status: "in review" },
    { topic: "home", summary: "Build the new home screen", what: "builds the new home screen with the three most used actions at the top", acceptance: "the home screen matches the approved design on both platforms", status: "done" },
    { topic: "a11y", summary: "Add screen reader labels to the home screen", what: "adds a screen reader label to every button on the home screen", acceptance: "the accessibility audit finds no unlabelled button", status: "done" },
    { topic: "a11y", summary: "Fix text clipping at large font sizes", what: "fixes text that clips when the font scale goes above 150%", acceptance: "text scales to 200% without clipping on every screen", status: "in progress" },
    { topic: "perf", summary: "Cut cold start time", what: "removes three startup tasks that block the first screen", acceptance: "cold start stays under 2 seconds on mid-range phones", status: "done" },
    { topic: "perf", summary: "Shrink the font files", what: "replaces the full font files with subsets for the supported languages", acceptance: "the app grows by less than 2 MB in 4.0", status: "in progress" },
    { topic: "beta", summary: "Triage beta feedback every Monday", what: "sets a Monday triage for beta feedback with an owner per area", acceptance: "every feedback item has an owner within a week", status: "done" },
    { topic: "crashes", summary: "Alert the team on crash spikes", what: "alerts the team channel when crashes double within an hour", acceptance: "a test spike reaches the channel within 5 minutes", status: "done" },
    { topic: "rollout", summary: "Start the iOS rollout at 5%", what: "starts the iOS rollout at 5% once store review passes", acceptance: "the iOS rollout reaches 5% with a crash-free rate of 99.5%", status: "open" },
    { topic: "offline", summary: "Put offline mode behind a flag", what: "puts offline mode behind a flag for 20% of beta testers", acceptance: "the flag can be turned off for everyone within 10 minutes", status: "done" },
    { topic: "review", summary: "Refresh the store screenshots", what: "refreshes the store screenshots for the new home screen", acceptance: "both stores show the new screenshots", status: "done" },
    { topic: "review", summary: "Update the location privacy label", what: "updates the privacy label for the new location prompt", acceptance: "both stores show the approved label text", status: "in review" },
    { topic: "home", summary: "Adjust dark theme colours", what: "adjusts dark theme colours to meet the contrast guideline", acceptance: "every text colour reaches a contrast ratio of 4.5 to 1", status: "done" },
    { topic: "train", summary: "Freeze the branch for the release candidate", what: "freezes the 4.0 branch on Tuesday before the candidate build", acceptance: "only crash fixes merge after the freeze", status: "in progress" },
    { topic: "beta", summary: "Recruit beta testers with older phones", what: "recruits 300 beta testers with phones older than four years", acceptance: "the beta has at least 300 testers on older phones", status: "in progress" },
    { topic: "perf", summary: "Keep scrolling at 60 frames per second", what: "removes layout work from the activity list", acceptance: "scrolling stays at 60 frames per second on mid-range phones", status: "in review" },
    { topic: "offline", summary: "Keep 30 days of activity offline", what: "keeps the last 30 days of activity on the phone", acceptance: "the activity screen opens offline with 30 days of data", status: "done" },
    { topic: "a11y", summary: "Fix the last two accessibility findings", what: "fixes the last two findings from the accessibility audit", acceptance: "the audit shows no open finding", status: "in progress" },
    { topic: "crashes", summary: "Add device context to crash alerts", what: "adds the phone model and memory to every crash alert", acceptance: "every crash alert names the phone model", status: "open" },
    { topic: "train", summary: "Write the 4.0 release checklist", what: "writes the checklist each release captain follows", acceptance: "two release captains use it without questions", status: "open" },
    { topic: "rollout", summary: "Add a rollout pause control", what: "adds a control that pauses the staged rollout at its current step", acceptance: "a test pause holds the rollout for 24 hours", status: "blocked", blockedBy: "waits on store console permissions for the release captains" },
    { topic: "home", summary: "Test the new home screen with customers", what: "runs usability tests of the new home screen with 12 customers", acceptance: "at least 9 of 12 customers finish the top three tasks faster", status: "done" },
    { topic: "beta", summary: "Close the 4.0 beta", what: "closes the 4.0 beta once the rollout passes 50%", acceptance: "beta testers move to the public build without a reinstall", status: "open" },
    { topic: "review", summary: "Write the 4.0 store text", what: "writes the store release text for 4.0 in five languages", acceptance: "both stores show the text in every supported language", status: "in progress" },
    { topic: "offline", summary: "Show sync status in the app", what: "shows when the app last synced and what is waiting to upload", acceptance: "testers can see waiting changes on every screen", status: "in review" },
    { topic: "perf", summary: "Measure startup on older phones", what: "adds startup timing for phones older than four years", acceptance: "the dashboard shows startup time by phone age", status: "open" },
    { topic: "crashes", summary: "Fix the camera permission crash", what: "fixes a crash when the camera permission is revoked during a scan", acceptance: "no camera permission crash appears on the beta for a week", status: "in progress" },
    { topic: "train", summary: "Plan the 4.1 train", what: "plans the scope of the 4.1 train after the rollout", acceptance: "the 4.1 scope is agreed by the product and mobile leads", status: "open" }
  ],
  masterIssues: [1, 3, 13, 18],
  pages: [
    { title: "Release train design", kind: "design", topic: "train", purpose: "how builds move from the main branch to the stores every second Thursday" },
    { title: "Decision record: staged rollout steps", kind: "decision", topic: "rollout" },
    { title: "Decision record: offline sync conflicts", kind: "decision", topic: "offline" },
    { title: "Playbook: crash spike during rollout", kind: "playbook", topic: "crashes", purpose: "crashes double within an hour during a rollout step" },
    { title: "Playbook: store review rejection", kind: "playbook", topic: "review", purpose: "a store reviewer rejects a build" },
    { title: "Mobile sync: rollout at 10%", kind: "meeting", topic: "rollout" },
    { title: "Mobile sync: beta feedback review", kind: "meeting", topic: "beta" },
    { title: "Mobile sync: store review status", kind: "meeting", topic: "review" },
    { title: "How to cut a release branch", kind: "howto", topic: "train", purpose: "cut a release branch for the train" },
    { title: "How to run a staged rollout", kind: "howto", topic: "rollout", purpose: "raise a staged rollout to its next step" },
    { title: "Accessibility checklist for new screens", kind: "reference", topic: "a11y", purpose: "what every new screen needs before it ships" },
    { title: "New home screen design", kind: "design", topic: "home", purpose: "the layout and colours of the new home screen" },
    { title: "Offline mode design", kind: "design", topic: "offline", purpose: "how the app stores activity and syncs changes offline" },
    { title: "Performance budget for 4.0", kind: "design", topic: "perf", purpose: "the startup, size and scrolling limits for 4.0" },
    { title: "Retrospective: the 4.0 beta", kind: "meeting", topic: "beta", status: "draft" }
  ],
  files: [
    { title: "Mobile 4.0 rollout plan", type: "doc", kind: "plan", topic: "rollout", status: "final", master: true, purpose: "the staged rollout of 4.0 on both platforms", say: ["The rollout is at 10% of Android users, and each step waits 48 hours at a crash-free rate of 99.5%."] },
    { title: "Offline mode spec", type: "doc", kind: "spec", topic: "offline", status: "final", purpose: "offline storage and sync for the activity screen" },
    { title: "Home screen design spec", type: "doc", kind: "spec", topic: "home", status: "final", master: true, purpose: "the new home screen layout", access: { users: ["c3"] } },
    { title: "Accessibility audit summary", type: "doc", kind: "summary", topic: "a11y", status: "final", purpose: "the accessibility audit of 4.0" },
    { title: "Store review answers", type: "doc", kind: "brief", topic: "review", status: "in review", purpose: "the answers to the store reviewer's questions" },
    { title: "Release captain guide", type: "doc", kind: "guide", topic: "train", status: "final", purpose: "how a release captain cuts the branch for a train" },
    { title: "Crash triage guide", type: "doc", kind: "guide", topic: "crashes", status: "final", purpose: "what to do when the crash-free rate drops" },
    { title: "Performance budget proposal", type: "doc", kind: "proposal", topic: "perf", status: "final", purpose: "startup and size limits for every release" },
    { title: "Beta programme plan", type: "doc", kind: "plan", topic: "beta", status: "final", purpose: "how the beta runs until the public release" },
    { title: "Privacy label text", type: "doc", kind: "brief", topic: "privacy", status: "in review", purpose: "the new location privacy label" },
    {
      title: "Crash-free rate tracker", type: "sheet", topic: "crashes", status: "final", master: true,
      rows: [
        "Build 4.0 beta 1, crash-free rate 99.2%, top crash image caching",
        "Build 4.0 beta 2, crash-free rate 99.4%, top crash camera permission",
        "Build 4.0 beta 3, crash-free rate 99.6%, no new top crash",
        "Build 4.0 candidate, crash-free rate 99.6%, rollout at 10% of Android users"
      ]
    },
    {
      title: "Rollout step tracker", type: "sheet", topic: "rollout", status: "final",
      rows: [
        "Android step 1%, held two days, crash-free rate 99.7%",
        "Android step 10%, holding, crash-free rate 99.6%",
        "Android step 25%, next, needs 48 hours at 99.5%",
        "iOS step 5%, waiting on store review"
      ]
    },
    {
      title: "Beta tester roster", type: "sheet", topic: "beta", status: "final",
      rows: [
        "Region Europe, 640 testers, 55% on Android",
        "Region Asia Pacific, 720 testers, 61% on Android",
        "Region Americas, 480 testers, 47% on Android",
        "Older phones, 300 testers across all regions"
      ]
    },
    {
      title: "Accessibility findings list", type: "sheet", topic: "a11y", status: "in review",
      rows: [
        "Finding 1, missing label on the scan button, fixed by {e3}",
        "Finding 4, text clipping in settings at 200%, open, owner {e4}",
        "Finding 7, low contrast on the dark theme tabs, fixed by {d1}",
        "Finding 9, focus order on the profile screen, open, owner {e1}"
      ]
    },
    {
      title: "Startup time by phone", type: "sheet", topic: "perf", status: "final",
      rows: [
        "Mid-range Android phone, cold start 1.9 seconds",
        "Older Android phone, cold start 3.1 seconds",
        "Recent iPhone, cold start 1.2 seconds",
        "Older iPhone, cold start 2.4 seconds"
      ]
    },
    {
      title: "Store review timeline", type: "sheet", topic: "review", status: "final",
      rows: [
        "Android build, submitted and passed on the first try",
        "iOS build, submitted and in review for two days",
        "Store screenshots, refreshed for the new home screen",
        "Privacy label, new location text approved by legal"
      ]
    },
    { title: "Mobile 4.0 review slides", type: "slides", topic: "overview", status: "final", master: true, purpose: "where the 4.0 release stands" },
    { title: "Home screen design slides", type: "slides", topic: "home", status: "final", purpose: "the new home screen and what customers said", access: { users: ["c3"] } },
    { title: "Rollout status slides", type: "slides", topic: "rollout", status: "final", purpose: "the staged rollout so far" },
    { title: "Beta results slides", type: "slides", topic: "beta", status: "final", purpose: "what the beta taught us" },
    { title: "Accessibility slides", type: "slides", topic: "a11y", status: "in review", purpose: "the accessibility audit and its fixes" },
    { title: "Performance slides", type: "slides", topic: "perf", status: "draft", purpose: "startup, size and scrolling in 4.0" },
    { title: "Exported crash summary", type: "pdf", kind: "summary", topic: "crashes", status: "final", purpose: "crash-free rates for every 4.0 build" },
    { title: "Exported store review summary", type: "pdf", kind: "summary", topic: "review", status: "final", purpose: "the store review history of 4.0" }
  ],
  channels: [
    { name: "mob-release", status: "the Android rollout is at 10% of users, and iOS waits on store review",
      topics: ["train", "rollout"], visibility: "public", agreements: [1, 3] },
    {
      name: "mob-war-room", status: "Android sits at 10%, and no new top crash has shown up since the image caching fix",
      topics: ["rollout", "crashes"], visibility: "private",
      access: { groups: ["mobile"], members: ["mobile", "pm", "maya"] }
    },
    { name: "mob-crashes", status: "the beta crash-free rate is up to 99.6%, and the camera permission crash is being fixed",
      topics: ["crashes"], visibility: "public", agreements: [0] },
    { name: "mob-store-review", status: "the Android build passed store review, and iOS waits on answers about account deletion",
      topics: ["review"], visibility: "public" },
    { name: "mob-design", status: "the new home screen is built, and the last two accessibility findings are being fixed",
      topics: ["home", "a11y"], visibility: "public", agreements: [2] },
    { name: "mob-beta", status: "the beta has 1,840 testers, and recruiting testers with older phones is under way",
      topics: ["beta"], visibility: "public" },
    { name: "mob-offline-mode", status: "offline mode is on for 20% of beta testers, and the sync status view is in review",
      topics: ["offline"], visibility: "public" },
    { name: "mob-accessibility", status: "7 of the 9 audit findings are fixed, and the last two are on the settings screens",
      topics: ["a11y"], visibility: "public" },
    { name: "mob-perf", status: "cold start is down to 1.9 seconds, and the font subsets are in progress",
      topics: ["perf"], visibility: "public" },
    { name: "mob-standup", status: "the Android rollout is at 10%, and the beta crash-free rate is 99.6%",
      topics: ["train", "crashes", "rollout", "beta"], visibility: "public" }
  ],
  agreements: [
    "Agreed: {e2} ships the image caching fix in the next train.",
    "Decision: each rollout step waits 48 hours before the next one.",
    "Approved: {d1} keeps the new home screen colours for 4.0.",
    "OK, let's hold the iOS rollout until store review passes."
  ],
  trackedBy: 2,
  copies: {
    superseded: [
      { title: "Mobile 4.0 rollout plan", older: [["10%", "1%"], ["99.5%", "99%"], ["48 hours", "24 hours"]] },
      { title: "Crash-free rate tracker", older: [["99.6%", "99.3%"], ["10% of Android users", "1% of Android users"]] }
    ],
    near: [{ of: "Offline mode spec", title: "Offline sync behaviour spec", changes: [] }]
  }
};
