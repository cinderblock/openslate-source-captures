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

## Needs your eye

| Page | What was seen | Suggested action |
| --- | --- | --- |
| `www.sierraclub.org/angeles/endorsements` | Chrome rendered 85 of 86 names, but a plain GET gets a 212-byte stub, on the home survey and on CI. No XHR holds them: the page itself loads after a script step | A plain GET can't capture this. A labelled browser capture, per plan Q5 |
| `www.venturagop.org/2026-general-election-voter-guides` | 0 of 56 names. The page links several Google Drive files (`drive.google.com/file/d/…/view`) | Probably the guides. A person needs to pick which ones, and `view` URLs are viewer pages, not the files |
| `www.cruzdemocrats.org/endorsements` | 0 of 8 names. Links two PDFs under `/_files/ugd/24c0bf_…` | Open them. Either may be the slate |
| `www.sjgop.org/endorsements` | 1 of 23 names in the HTML, none rendered. The page is full of square `wixstatic.com` images | Picks are probably in the images, which would need listing one by one |
| `smcdems.org` | 0 of 37 names, and CI's plain GET got a **403**, while home Chrome loaded it | Blocked for CI. Also, the source is the home page, so the slate's real page may be elsewhere |
| `www.alamedagop.org/posts/2026-10-11-voter-guide-statewide` | Nothing to score: no position cites this URL directly, so 0 names were expected. The HTML shows a `county_voter_guide.png` | Confirm whether the guide is that image |
| `workingfamilies.org/states/california/` | 6 of 31 names rendered, and it redirects to `/state/california/`. It links separate endorsement posts | The picks look spread across several posts, which aren't in the list |

## Nothing found

No response held half the names, and the page text didn't either. Some of these may keep their
picks in images or linked files. That hasn't been checked.

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
- Nothing here needed a login, and no POST was proposed. Capture only does GET, so a source that
  turned out to need one would have to wait.
- Only XHR and fetch responses are listed in full, and PDFs loaded another way weren't recorded in
  this batch: the PDF listing was added after the loads, on what linkjar showed.
- `workingfamilies.org` loaded on a second attempt, after a bug in the helper stopped the first
  before any request went out.
- Chrome ran from a home connection. A site may treat a GitHub runner differently, as `smcdems.org`
  did.
