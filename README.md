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

Each URL is requested once per run, at most one at a time per host. A file cited with several
`#page=` fragments is one request.

### Hosts that don't answer a plain GET

- **Blocked from CI.** Some sites refuse GitHub's address range. A separate run from a home address
  (`bun src/run.ts out --only-hosts ...`) fills those in. It's timestamped but has no CI witness, and
  its manifest says so. `CAPTURE_GUARD_IPS` keeps any response that prints that address private.
- **Answered with a stub.** Hosts in `render-hosts.json` are also loaded once in headless Chrome,
  beside the plain GET and never instead of it, with the same honest user agent and nothing that
  hides that it's automated. The record is marked `headless-chrome`, because it's Chrome's decoded
  view and the DOM its scripts built, not socket bytes. The list is public so the exception can be
  reviewed.

## Layout

```
sources.json          what the latest run set out to fetch, and why
discovered.json       data URLs a human found behind a page
withheld-hosts.json   hosts whose bytes stay private, beyond the automatic news rule
render-hosts.json     hosts also loaded in headless Chrome, and why
runs/<id>/            manifest.json, stamps/*.tsr, manifest.sigstore.json, placement.json
blobs/ab/<sha256>     raw requests, responses and certificates
provenance/<org>/<election>.json   which captures back each slate, and what can be checked
archived.json         Internet Archive snapshots, and whether their text agrees
trust/                pinned timestamp roots and the Sigstore trust root
```

Responses from news sites and social platforms are captured and proven like everything else, but
their bytes are kept in a private repository, because they're others' copyrighted work or may carry
personal data. Their hashes are public, so those bytes can be shared on request and checked. Files
over 5 MB are assets on the `large-blobs` release.

Captures are marked `-text` in `.gitattributes`. Git must never normalize their line endings.

## Verify in a browser

[The verifier page](https://cinderblock.github.io/openslate-source-captures/) checks a run on your
own machine: no server is involved in the answer. Give it a run id, or pick a folder holding a run
or a copy of this repository. Its trust roots are built in, so a saved copy works with the network
off and the source sites long gone, and a mirror of this repository works as well as the original.

It runs the same `src/verify-core.ts` as the command line. The one difference is that the browser
check skips the Sigstore certificate's Certificate Transparency timestamp; the command line also
runs the reference Sigstore library, which checks it.

## Commands

```
bun install
bun src/sources.ts <openslate-public-endorsements checkout>   # regenerate sources.json
bun src/run.ts out                                            # capture
bun src/seal.ts out                                           # timestamp
bun src/publish.ts out --private <dir>                        # place the bytes
bun src/verify.ts runs/<id>                                   # verify offline
bun src/build-provenance.ts <endorsements checkout>           # rebuild provenance/
bun src/archive.ts lookup | compare <checkout> | save         # Internet Archive, best effort
bun src/discover.ts --from <endorsements checkout> <url>      # find the data behind a page
bun test src web
bun run build-web                                             # build the verifier page into site/
bun web/e2e.ts out/smoke [<checkout>]                         # drive that page in headless Chrome
```

`discover.ts` loads a page once in headless Chrome and reports which responses hold the names the
slate expects. It only proposes: a person adds what's worth keeping to `discovered.json`, and capture
stays a plain GET. `discovery-report.md` records the last pass and what still needs a person.

Runs on Windows without WSL and on GitHub Actions.

## If this project's requests bother you

The user agent names this page. Please open an issue and we'll stop.
