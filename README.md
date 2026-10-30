# OpenSlate source captures

Verbatim, time-stamped copies of the sources that [OpenSlate](https://openslate.us)'s endorsement
slates cite, so anyone can check a slate against what a source said even after the source goes away.

Design, threat model and evidence: `plans/signed-source-capture.md` in
[cinderblock/OpenSlate](https://github.com/cinderblock/OpenSlate).

## What a run proves, and what it doesn't

| Layer | Says | Doesn't say |
| --- | --- | --- |
| Raw bytes, named by SHA-256 | These are the exact bytes we used | When, or from where |
| Two RFC 3161 timestamps | These bytes existed by this time, unchanged | That the server sent them |
| Sigstore attestation from public CI | This public code, on GitHub's runner, produced this run | That the site wasn't hacked or showing bots something else |

Nothing here proves a domain speaks for an organization. A saved HTTPS session can't prove what a
server sent at all, so none is claimed.

## Rules

- Whole responses, verbatim. No filtering, cleaning or byte ranges.
- Every intended URL gets an outcome, including errors, timeouts, 403s and stubs.
- The same tool, rules and honest user agent for every organization.
- The URL list is generated mechanically from the published slates (`src/sources.ts`).
- No model anywhere in capture or verification.

Each URL is requested once per run, at most one at a time per host.

## Layout

```
sources.json          what the latest run set out to fetch, and why
discovered.json       data URLs a human found behind a page
withheld-hosts.json   hosts whose bytes stay private, beyond the automatic news rule
runs/<id>/            manifest.json, stamps/*.tsr, manifest.sigstore.json, placement.json
blobs/ab/<sha256>     raw requests, responses and certificates
```

Responses from news sites and social platforms are captured and proven like everything else, but
their bytes are kept in a private repository, because they're others' copyrighted work or may carry
personal data. Their hashes are public, so those bytes can be shared on request and checked. Files
over 5 MB are assets on the `large-blobs` release.

Captures are marked `-text` in `.gitattributes`. Git must never normalize their line endings.

## Commands

```
bun install
bun src/sources.ts <openslate-public-endorsements checkout>   # regenerate sources.json
bun src/run.ts out                                            # capture
bun src/seal.ts out                                           # timestamp
bun src/publish.ts out --private <dir>                        # place the bytes
bun src/verify.ts runs/<id>                                   # verify offline
bun test src
```

Runs on Windows without WSL and on GitHub Actions.

## If this project's requests bother you

The user agent names this page. Please open an issue and we'll stop.
