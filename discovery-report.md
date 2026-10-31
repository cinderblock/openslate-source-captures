# Discovery report

Each of the 18 hosts whose cited page held under 20% of its expected names got one page load in
headless Chrome, with the honest user agent and no retries, on 2026-10-30, 10:07–10:17 AM PDT
(17:07–17:16Z). Run with `src/discover.ts`.

"Expected" is the surnames of the positions citing that URL. "Rendered" is how many appeared in the
top-level page's text after scripts ran. Text inside iframes wasn't counted. Links below come from
reading run `2026-10-30T1700Z`'s saved HTML, which made no new requests.

## Added to `discovered.json`

These are the clear cases, and capture will GET them from the next run on.

| Page | Added | Evidence |
| --- | --- | --- |
| `apps.lavote.gov/candidate-statements/` | `statements-api/oc/read/election/4348/contest` | JSON, 594 of 594 names |
| `lagop-endorsement-lookup.vercel.app` | The app's `page-…js` script chunk | 91 of 93 names. The URL is build-specific, so a redeploy will show up as a 404 |
| `linkjar.to/voter-guide-2026/` | `_/pdf/aa0dc48e-…/` | Inferred: the only data loaded, and the page rendered 33 of 94 names. The PDF itself wasn't read |
| `fresnocountydemocrats.org/…/democratic-party-endorsements/` | `FCDCC-Endorsements-2026-Midterm-Election-792x1024.jpg` | By filename only. The image wasn't read |

The Fresno page also shows `CADEM-Endorsements-2026-Midterm-Election-791x1024.png`, which looks like
the state party's list, so it wasn't added.

## Resolved on a second pass

Checked on 2026-10-30, 5:00 PM PDT (2026-10-31 00:00Z), by reading the saved pages and each slate's
own evidence notes. None of these needed a person after all.

Transcribed slates were read off images or PDFs, and their notes say which. `src/sources.ts` now
lists every document those notes name, 149 of them across 19 slates, so what was read gets captured
as well as the page around it. No one picks them, and that rule also reaches slates this report never
looked at, Abundant Housing LA's 48 cards for one.

| Page | Finding | Now |
| --- | --- | --- |
| `www.sierraclub.org/angeles/endorsements` | The stub is a script step | Covered: `render-hosts.json` loads it in Chrome beside the GET |
| `www.venturagop.org/2026-general-election-voter-guides` | The five Drive files are the slate's five district flyers, read and confirmed | The notes' copies by rule, and the full-size originals in `discovered.json` |
| `www.cruzdemocrats.org/endorsements` | The two PDFs are the party's bylaws and procedures manual, not the slate. The picks are eight image cards | Already captured, through `attribution.sources` |
| `www.sjgop.org/endorsements` | The 23 card images are the slate, and the notes list each | By rule |
| `smcdems.org` | The list is one PNG, and CI gets a 403 on the page, not on the PNG | PNG already captured from CI. The page needs a home fill-in, listed below |
| `www.alamedagop.org/posts/2026-10-11-voter-guide-statewide` | `county_voter_guide.png` is the statewide guide, and `alameda_county_candidates.png` the county list. Both read and confirmed | By rule |
| `workingfamilies.org/states/california/` | The list is in one table, not spread across posts. The page holds 10 rows, and its View More button POSTs for the rest | The POST is in `discovered.json`. One request held all 31 names |

## Still open

Three transcribed slates' evidence notes name no document: `newport-beach-city-clerk`,
`riverside-county-republican-party`, `sf-department-of-elections`. What they were read from wasn't
looked into.

## Nothing found

No response held half the names, and the page text didn't either. Where the slate was transcribed,
the rule above now captures the documents its notes name. The rest hasn't been checked.

| Page | Expected | In the page's HTML | Rendered | Note |
| --- | --- | --- | --- | --- |
| `alamedacountyca.gov/rov_app/candidatelist/` | 205 | 1 | 0 | No XHR. May need a selection first, so possibly a form post, which capture can't do. Not confirmed |
| `ocvote.gov/candidates/candidate-filing-log-with-statements` | 320 | 0 | 0 | Only analytics POSTs |
| `bhdemocrats.org/index.php/endorsements-november-2026/` | 16 | 0 | 0 | No XHR and no linked PDF |
| `candidates.aipacpac.org/page/featured` | 25 | 0 | 0 | Only widget and telemetry calls. The app may not have fully rendered |
| `maps.cartifact.com/porac/` | 91 | 1 | 0 | A map app with no XHR. Binary map data can't be read by this check |
| `www.kerndemocrats.com` | 34 | 1 | 0 | The source is the home page |
| `www.lincolnclub.org/voterguide` | 93 | 2 | 0 | |

## Limits

- The match is surnames as whole words, so a hit isn't proof that a response is the slate, and a
  miss doesn't show the names are absent. Binary responses aren't read.
- Nothing here needed a login. Capture sends a POST only where `discovered.json` spells one out.
- Only XHR and fetch responses are listed in full, and PDFs loaded another way weren't recorded in
  this batch: the PDF listing was added after the loads, on what linkjar showed.
- `workingfamilies.org` loaded on a second attempt, after a bug in the helper stopped the first
  before any request went out.
- Chrome ran from a home connection. A site may treat a GitHub runner differently, as `smcdems.org`
  did.
