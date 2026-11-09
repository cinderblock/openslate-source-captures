# Sources that keep failing

Written by `src/failing.ts` after each CI run. Updated 2026-11-08 6:51 PM PST (02:51Z).

A URL is listed when its final outcome, after the retries in `src/retry.ts`, wasn't a 200 in
the newest CI run and in at least 3 of the last 4. Each is something for a
developer to look into. This says how the requests went, never anything about a page's content.

CI runs counted, newest first: `2026-11-09T0219Z`, `2026-11-05T1746Z`, `2026-11-05T1300Z`, `2026-11-04T1740Z`.

## Needs a look

34 URLs failing from CI, and from home too or not tried there.

### No response. The site may be down or overloaded, or dropping our connections.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://www.sacbee.com/news/politics-government/capitol-alert/ | no response (timeout: no data) after 3 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/news/politics-government/election/ | no response (timeout: no data) after 3 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/ | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article316832589.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article316956698.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317045348.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317051745.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317079847.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317131383.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317171649.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317172915.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317182902.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317497694.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317514817.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317765284.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/opinion/election-endorsements/article317856063.html | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |
| https://www.sacbee.com/search/ | no response (timeout: no data) after 2 tries, no response (timeout: no data), no response (timeout: no data), no response (timeout: no data) | 2026-11-05T1322Z: no response (timeout: no data) |

### Refused (401 or 403). The site may be blocking automated requests or this address range.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://www.nfib.com/news/press-release/california-small-businesses-endorse-slate-of-candidates-for-election-to-congress/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.nfib.com/news/press-release/nfib-announces-california-ballot-proposition-choices/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.nfib.com/news/press-release/small-business-pac-endorses-30-candidates-for-the-california-legislature/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.sanbenitocounty-ca-cre.gov/home/showpublisheddocument/16343/639237846936770000 | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.smdailyjournal.com/opinion/editorials/daily-journal-endorsements-for-the-san-mateo-county-november-election/article_9e726e39-e27e-4b9b-ba42-5addaf7dab5b.html | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.smdailyjournal.com/opinion/editorials/editorial-booker-brownstone-and-ruddock-for-half-moon-bay-city-council/article_79bbc030-75ba-4470-9893-2489506d8b3e.html | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.smdailyjournal.com/opinion/editorials/editorial-yes-on-measure-y/article_8a857ee4-5e2f-4bf7-920a-f92d09e47fcb.html | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |
| https://www.smdailyjournal.com/opinion/editorials/editorial-yes-on-measures-j-and-u-no-on-measures-l-and-aa/article_3df72153-8634-48dc-9781-ceecbd5c72e8.html | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 403 |

### A success code that isn't the page (such as 202). Often a bot check.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://ballotpedia.org/Endorsements_by_San_Francisco_Chronicle_Editorial_Board | 202 after 3 tries, 202, 202, 202 | 2026-11-05T1322Z: 202 |

### Gone or moved (404 or 410). The slate may cite an address that no longer exists.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://cragop.org/2026-primary-election-endorsements/ | 404 after 3 tries, 404, 404, 404 | not tried |
| https://cragop.org/2026/03/21/california-republican-assembly-june-2026-primary-election-endorsements/ | 404 after 3 tries, 404, 404, 404 | not tried |
| https://emilyslist.org/candidate/marni-von-wilpert/ | 404 after 3 tries, 404, 404, 200 | not tried |
| https://jstreetpac.org/candidate/mike-levin/ | 404 after 3 tries, 404, 404, 404 | not tried |
| https://jstreetpac.org/candidate/sydney-kamlager/ | 404 after 3 tries, 404, 404, 404 | not tried |
| https://lagop-endorsement-lookup.vercel.app/_next/static/chunks/app/page-6de5274a16e7b1f6.js?dpl=dpl_GQ36V56UvLmxAzBWhCHYevkbNL3s | 404 after 3 tries, 404, 404, 404 | not tried |
| https://sfyimby.org/endorsements/2026-primary-election/ | 404 after 3 tries, 404, 404, 404 | not tried |

### Server error (5xx). The site may be overloaded, or the address behind the page changed.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://candidates.aipacpac.org/api/v2/donation-page/featured | 500 after 3 tries, 500, 500, 500 | 2026-11-05T1322Z: 500 |

## Refusing CI only

24 URLs that came back 200 from home. Lower priority: they refuse only CI, and a home run of `src/fill-in.ts` can fill them in.

### Refused (401 or 403). The site may be blocking automated requests or this address range.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://apnews.com/ap-sitemap.xml | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://apnews.com/hub/california | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://apnews.com/search | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://files.santaclaracounty.gov/exjcpb1296/2026-09/qualified-list-of-local-candidates-9-28-26.pdf | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://files.santaclaracounty.gov/exjcpb1296/2026-09/qualified-list-of-local-candidates-9-28-26.pdf?VersionId=CM6jbwAVTLFIjLakj6hJku2l9KPAIxli | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://sfbike.org/news/endorsing-scott-wiener-for-congress/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://sfbike.org/news/vote-no-on-prop-g-save-sunset-dunes-park/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://sfbike.org/news/vote-yes-for-transit-funding-measures-h-and-rtm/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://sfbike.org/our-work/bike-the-vote/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://smcdems.org/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.lacdp.org/ballotmeasures | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.lacdp.org/candidates | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| http://www.milkclub.org/endorsements | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.milkclub.org/endorsements | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.sfcadc.org/cadc_11_2026_recommendations | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.sfcadc.org/endorsements | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.southbaylabor.org/2026_endorsements | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.stonewalldems.org/2026_stonewall_endorsed_candidates | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.theleaguesf.org/ | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.theleaguesf.org/june_2026_endorsements | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |
| https://www.theleaguesf.org/november_2026_endorsements | 403 after 3 tries, 403, 403, 403 | 2026-11-05T1322Z: 200 |

### A success code that isn't the page (such as 202). Often a bot check.

| URL | CI, newest first | From home |
| --- | --- | --- |
| https://www.sf.gov/qualified-ballot-measures | 202 after 3 tries, 202, 202, 202 | 2026-11-05T1322Z: 200 |
| https://www.sf.gov/ranked-choice-voting | 202 after 3 tries, 202, 202, 202 | 2026-11-05T1322Z: 200 |
| https://www.sf.gov/reports--candidates-nov-3-2026-general-election | 202 after 3 tries, 202, 202, 202 | 2026-11-05T1322Z: 200 |
