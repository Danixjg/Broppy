# Rust migration verification

The pre-migration baseline passed 426 TypeScript tests, with one skipped. The web Node suite failed its audit-summary coverage check because four server events lacked summaries. The migration adds those summaries and retains the coverage check.

Final verification passed on Linux x86_64 with Rust 1.99.0 and Node 24.21.0:

This run installed the official toolchain under `/tmp` without changing the user's shell. To use that installation in this workspace:

```sh
export CARGO_HOME=/tmp/broppy-cargo
export RUSTUP_HOME=/tmp/broppy-rustup
export PATH="$CARGO_HOME/bin:$PATH"
```

For a persistent development setup, use the normal rustup installation described in [the migration guide](../rust-migration.md).

| Check | Result | Run artifact |
| --- | --- | --- |
| Locked native release build | Passed | `/tmp/broppy-native-final-build.log` |
| `pnpm test`: Cargo workspace | 46 core and 8 anchor tests passed | `/tmp/broppy-final-tests.log` |
| `pnpm test`: TypeScript | 432 passed, one skipped across 41 files | `/tmp/broppy-final-tests.log` |
| `pnpm test`: web Node checks | 22 passed | `/tmp/broppy-final-tests.log` |
| `pnpm rust:check` | Formatting and Clippy passed with warnings denied | `/tmp/broppy-rust-check-final.log` |
| `pnpm typecheck` | Root and web passed | `/tmp/broppy-typecheck-final.log` |
| Frozen offline dependency install | Passed | `/tmp/broppy-install-frozen.log` |
| `pnpm rust:smoke` | Real HTTP query, denial, workspace, audit search, signed disk reload and independent anchor verification passed | `/tmp/broppy-rust-smoke-final.log` |

Original-output replay passed for 3,156 policy/access corpus cases plus lifecycle and link edges, 7,639 audit/task/query comparisons, 1,622 grounding cases, and 344 workspace/audit-search cases. Independent review added 831 bulk project-assignment comparisons. Evidence lives in the corresponding `/tmp/broppy-*-final*`, `/tmp/broppy-workspace-parity-report.json`, and `/tmp/broppy-projects-of-review-result.json` artifacts. Temporary evidence files are local to this run; the checked-in behavior tests and smoke script are the durable verification commands.

The first migrated full-suite run was interrupted because the dataset validator repeatedly serialized the complete Jira corpus per project and thread. The caller now batches project assignment and authorization. All ten dataset tests pass; the isolated test with over 18,000 documents completed in 6.32 seconds. The isolated dataset test file took 7.93 seconds; it took 12.02 seconds in the final concurrent suite, compared with 4.34 seconds recorded in the pre-migration suite. These are test-run observations, not a controlled benchmark. This migration does not establish a speedup; ranking now runs on native workers, and remaining boundary overhead requires workload-specific measurement.

The pstack workflow used Model the Domain for native index and policy ownership, Boundary Discipline for preserved JavaScript byte/date/locale contracts, and Prove It Works for real compiled-module and HTTP verification. Independent review by gpt-6.1-sol found an overflowing-vector process abort and Unicode regex drift; both were fixed and independently rechecked on the rebuilt addon. The [review](review.md) and [decision trail](decisions.tsv) record the findings and final checkpoints.

Docker is installed as a Windows integration command, but this WSL distribution has no active Docker engine. The production image cannot be built here. Vercel deployment is also unverified. Its build configuration and native-library inclusion are present for review.

External Auth0, provider credentials, hosted Supabase/OpenFGA, Docker startup and Vercel were not exercised against live services. Their existing mocked behavior tests pass. Browser UI and platform transports remain TypeScript; the nine migrated domain modules execute in Rust with no JavaScript algorithm fallback.
