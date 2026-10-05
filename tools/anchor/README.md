# brain-anchor

A small Rust tool that closes the audit log's open item: *an independent write-once root anchor*
(`docs/trust-boundary.md`, `decisions.md` D50).

The API signs every Merkle batch, but anyone holding the signing key and the log file could rewrite both. This tool
copies each signed batch root into an append-only `anchors.jsonl` in a **separate repository**. Once a root is pushed
there, a rewrite or deletion of the log no longer matches it.

It has no network code and never sees the private key. It takes the **public** key only.

```sh
cd tools/anchor && cargo build --release        # not part of the pnpm workspace

# publish, from a checkout of the separate anchor repository
brain-anchor publish --log /path/to/audit.jsonl --pubkey audit.pub.pem --anchors anchors.jsonl
git add anchors.jsonl && git commit -m "anchor batches" && git push

# check at any time, for example before the demo; exit status 1 means tampering
brain-anchor verify  --log /path/to/audit.jsonl --pubkey audit.pub.pem --anchors anchors.jsonl
```

- Both commands first check the whole log:
  - every entry's hash against its content, computed exactly as `packages/audit` computes it;
  - the chain from each entry to the one before;
  - each batch's signature and its link to the previous root;
  - each batch's root against the entries it covers.

  A changed, deleted or reordered entry fails, even when the batch records around it are untouched.
- `publish` then appends only batches the anchors don't have. It refuses, writing nothing, if the log disagrees with an
  anchor already published.
- `verify` also reports a batch that differs from its anchor ("the log was rewritten") or a missing one ("batches
  were deleted").
- Public key from the private one: `openssl pkey -in audit.pem -pubout -out audit.pub.pem`.
- Reads the JSONL log (`AUDIT_LOG_PATH`). Batches kept only in Supabase aren't read yet.
- `cargo test` checks the Rust side against a real 130-entry log written by the TypeScript `AuditLog`
  (`tests/fixtures`, a throwaway test key), including entries with nested data, decimals and quoted text.
