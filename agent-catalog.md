# Agent Catalog

This scaffold adapts the useful capability boundaries from `finografic/pstack` to the existing domain-oriented layout. It defines who should reason about future work; it intentionally adds no scripts or implementation machinery.

## Structure

```text
.
|-- AGENTS.md
|-- harness.md
|-- orchestator.md
|-- Understanding/
|   |-- TEAM.md
|   |-- code-explorer.md
|   |-- rationale-investigator.md
|   |-- impact-analyst.md
|   `-- context-reconstructor.md
|-- Design/
|   |-- TEAM.md
|   |-- system-architect.md
|   `-- delivery-planner.md
|-- Web/
|   |-- TEAM.md
|   |-- web-architect.md
|   |-- frontend-builder.md
|   `-- backend-builder.md
|-- Docker/
|   |-- TEAM.md
|   |-- container-architect.md
|   `-- container-verifier.md
|-- Automation/
|   |-- TEAM.md
|   |-- automation-architect.md
|   `-- automation-verifier.md
|-- Testing/
|   |-- TEAM.md
|   |-- test-strategist.md
|   |-- verification-curator.md
|   `-- e2e-runner
|-- Review/
|   |-- TEAM.md
|   |-- evidence-auditor.md
|   `-- code-hygiene-reviewer.md
|-- Writing/
|   |-- TEAM.md
|   |-- technical-writer.md
|   `-- prose-editor.md
`-- Foundations/
    |-- TEAM.md
    |-- principles-advisor.md
    `-- practice-curator.md
```

## pstack capability mapping

| pstack capability | Local owner | Reason for placement |
| --- | --- | --- |
| `how`, `teach` | `Understanding/code-explorer.md` | Runtime tracing and explanation use the same evidence. |
| `why` | `Understanding/rationale-investigator.md` | Historical intent needs a separate evidence standard. |
| `blast-radius` | `Understanding/impact-analyst.md` | Impact analysis happens before design or implementation. |
| `recall` | `Understanding/context-reconstructor.md` | Resuming work is context reconstruction, not planning. |
| `architect` | `Design/system-architect.md` | Owns interfaces, boundaries, and design alternatives. |
| `figure-it-out` | `Design/delivery-planner.md` | Owns auditable plans for ambiguous or multi-stage work. |
| `tdd` | `Testing/test-strategist.md` | Defines the failing-before contract; OpenCode writes the test and fix. |
| `create-verification-skill`, `maintain-verification-skill` | `Testing/verification-curator.md` | One owner defines and maintains verification contracts. |
| `show-me-your-work` | `Review/evidence-auditor.md` | Reviews whether decisions and claims are backed by evidence. |
| `no-comments` | `Review/code-hygiene-reviewer.md` | Reviews implementation clarity without becoming an implementer. |
| `technical-writing` | `Writing/technical-writer.md` | Owns durable engineering documentation. |
| `unslop`, `bro` | `Writing/prose-editor.md` | Both simplify language without changing technical meaning. |
| `principles` | `Foundations/principles-advisor.md` | Provides shared decision criteria without owning delivery. |
| `reflect` | `Foundations/practice-curator.md` | Converts repeated lessons into proposed role or process changes. |

`typescript-best-practices` is deferred until the project chooses a TypeScript use case. Language-specific roles should be added inside the domain that uses them, not globally.

The pstack orchestration scripts, multi-vendor fan-out, verification scripts, and installer files are also deferred. They would prematurely choose runtime behavior that this scaffold is meant to leave open.

## Research basis

- [finografic/pstack](https://github.com/finografic/pstack) groups its portable skills by understanding, design, verification, prose, and foundations.
- Its [porting roadmap](https://github.com/finografic/pstack/blob/master/docs/todo/ROADMAP.md) recommends keeping the advertised skill surface small and records why its vendor-bound orchestrator and multi-vendor workflows were not shipped.

This repository adopts those capability boundaries, not pstack's files or runtime machinery. The local domain teams and OpenCode-only implementation boundary are specific to this scaffold.
