# The Atlas Reference Collection

A fixed, curated set of public-domain artworks that ships inside Atlas 1.4.0. It is the yardstick and the playground for
the Artistic Discovery Engine: it does not depend on what a user happens to have on their computer, it works offline, and
every work carries its provenance.

## What is in it

**1,162 works** in **44 shelves**, grouped by the computer into **22 regions** of visual similarity.

| Museum | Works | Open-access policy |
| --- | --- | --- |
| Cleveland Museum of Art (CMA) | 696 | https://www.clevelandart.org/open-access |
| Art Institute of Chicago (AIC) | 466 | https://www.artic.edu/open-access |

Shelves are human-chosen slices of art history, not aesthetic verdicts: Western painting by period (medieval to
early-modern, plus landscape, still life, portraiture, Impressionism, Post-Impressionism and Symbolism, American painting,
abstraction, fantastic and dreamlike imagery), prints and drawings (ukiyo-e, European etchings and engravings, posters,
botanical illustration), Asian painting, sculpture, ceramics and calligraphy, Islamic manuscripts and pattern, Egyptian,
Greek and Roman art, African, Native American, Oceanic and Pre-Columbian art, medieval objects, European and modern sculpture,
nineteenth- and twentieth-century and documentary photography, architecture (drawings, plans, photographs), Art Nouveau and
Arts and Crafts design, textiles, furniture, glass, ceramics and jewelry. The full list with counts is in
`reference/manifest.json` and in the app (Taste, About the collection).

## Licensing and provenance

- **Only works that the museum itself publishes as public domain / CC0** were eligible: AIC `is_public_domain = true`,
  CMA `share_license_status = "CC0"`. The license applied is **CC0 1.0 Universal**
  (https://creativecommons.org/publicdomain/zero/1.0/).
- Every work in `manifest.json` records: museum, object id, **museum object page**, **API record**, title, maker (with
  nationality and dates where given), date, culture/place, classification, medium, department, **credit line**, shelf,
  the source image URL, and a **SHA-256 of the stored image**. The app shows the title, maker, date, museum, credit line,
  license and a link to the museum page next to every work.
- Images are small web copies (at most 800 px, WebP) made for browsing, not for reproduction. A museum may later change its
  statement about a work; its own object page is authoritative.
- `reference/CREDITS.md` credits the museums. CC0 does not require it; it is done as a courtesy. Atlas is not affiliated
  with the museums.
- A pack of this kind can be audited: `reference/embeddings.f32` and `reference/concepts.f32` are checked against hashes
  in the manifest when Atlas loads them, and a damaged pack is refused (Taste then says the collection is missing).

## How it was built (and how to rebuild it)

```powershell
node scripts/reference/harvest.mjs        # find eligible works on each shelf, download small copies (resumable)
node scripts/reference/embed-pack.mjs     # embed with SigLIP, drop near-duplicates, group into regions, lay out the map
```

`scripts/reference/curation.mjs` is the curation plan (shelves and the museum queries behind them). The harvest script
identifies itself to the museums (the Art Institute asks for an `AIC-User-Agent` header, which carries no personal
details), paces its requests, and stops using a museum that refuses requests.

Selection rules: a shelf is filled from several queries, shuffled with a fixed seed, with **at most 3 works per maker per
shelf and 7 overall**, so no single artist dominates; duplicate works and near-duplicates (embedding similarity above
0.985) are removed; images smaller than 300 px are rejected.

## Known limits (please read)

- **Two museums, both American.** The Metropolitan Museum of Art also publishes open-access works, but its API firewall
  refused the builder's automated requests after a handful of calls; Atlas does not try to get around such a block, so
  The Met is not in this first edition (the harvest script has an opt-in `--met` switch). The collection therefore leans
  towards what these two museums collect and towards periods old enough to be public domain: **abstraction, surrealism and
  contemporary art are thin** (25 to 30 works per shelf, and no living artists), and some world-art shelves are small
  (Egyptian: 11, Islamic: 17).
- Region and shelf names describe what is most common in a group; they are labels for orientation, not judgements.
- The collection is a sample, not "art history". A taste profile built on it describes a person relative to this sample.
- More museums can be added by extending `curation.mjs` with sources that publish CC0 data and images and rebuilding the pack.
