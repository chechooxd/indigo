# Gate execution evidence — studio-erd-designer

## Why this directory exists

The verify-report envelope (`gentle-ai.verify-result/v1`) records `test_exit_code`,
`build_exit_code`, and sha256 output hashes, but carries no way to attach the outputs
those values summarize. The archive gate reads and trusts that envelope. A reviewer
raised this as a CRITICAL reliability finding against the report itself
(`review-f3fe98aacd813d4e`, R3-1):

> No log, CI artifact, or any other changed file accompanies this changeset to
> substantiate the claimed command outputs or hashes — the only evidence for
> `pnpm exec turbo test --force` and `pnpm build --force` having actually run and
> exited 0 is this document's own prose.

The finding is about **contrastability, not veracity**. It stands whether or not the
claims are true, because nothing in the changeset lets a later reader check them.
This directory is the missing half: the raw outputs, hashed, so the envelope's numbers
can be recomputed rather than believed.

Note that the validator's own contract already states *"Independent test and build
execution evidence is required for a passing verification result."* The requirement was
never the gap — the transport was.

## What is here

| File | Command | Exit |
|---|---|---|
| `lint.log` | `pnpm exec turbo lint --force` | 0 |
| `build.log` | `pnpm clean && pnpm build --force` | 0 |
| `test.log` | `pnpm exec turbo test --force` | 0 |
| `MANIFEST.txt` | sha256 of each log above | — |

Every log in this directory was produced by the orchestrator re-running the command
itself, not copied from a delegated agent's summary. The subagent that wrote the
verification pass removed its own temporary logs, so reusing its hashes would have
reproduced exactly the defect this directory answers.

## How to check the envelope against these logs

```sh
cd openspec/changes/studio-erd-designer/evidence
shasum -a 256 -c MANIFEST.txt          # logs are unmodified since capture
rg -n 'Tasks:|Cached:|_EXIT=' *.log    # counts and exit codes the envelope asserts
```

## What this does NOT fix

The report format remains self-attested by design: these logs live beside the report,
not inside the envelope the gate parses, and nothing mechanically ties one to the other.
A future reader must open this directory deliberately. Closing that gap means changing
`gentle-ai.verify-result/v1` to carry evidence references the validator checks — which
is upstream work, not something this change can do.
