# The Artistic Discovery Engine: architecture and evidence

*NOEMA Atlas 1.4.0. Builds on the Taste Compass ([TASTE-ARCHITECTURE.md](TASTE-ARCHITECTURE.md)).*

## What the 1.4.0 compass could not do

1. It learned only from the user's own library. Accidental screenshots and technical renders there taught it the wrong
   thing, and a library that is 60% landscapes made "landscape" look like a taste.
2. One straight line through the embedding space cannot describe a person who loves romantic landscapes **and** minimalist
   architecture **and** abstract sculpture: the line lands between them and prefers none.
3. Every answer was "A over B". "I like both", "I like neither" and "I can't decide" are different facts.
4. It could only describe a person, not take them anywhere new.

## Architecture

```
 Atlas Reference Collection (1,162 public-domain works, offline, fixed)
        │  same SigLIP embedding space as the user's images
        ├── yardstick: what is typical of art in general  ──► every quality is measured against it
        │
 MY ARTISTIC IDENTITY            MY DISCOVERED TASTE
 favorites only                  exploring the reference collection
 (modes, qualities, kindred      (5 answers → one model that can hold several
  works)                          separate preferences)
        └────────────┬───────────────────────┘
               COMPARISON: agree · one-sided · differ · unexplored (map + qualities, every claim qualified)
                     │
          ARTISTIC DISCOVERY JOURNEYS (start where you are, travel, deliberately stretch)
                     │ reactions, saves (copied into the library as normal images with provenance)
               HISTORY: snapshots of both profiles over time
```

Everything runs locally. Exploring, journeys, saving and history need only the shipped collection (its embeddings and the
embedded descriptions of the twelve qualities are in the pack), **not** the image model. The model is needed only to look
at the user's own favorites (identity) and for the classic library features.

## Two independent profiles

### My Artistic Identity (`src/main/identity.ts`)

Input: the images explicitly marked as **favorites**, nothing else. How common a style is in the rest of the library is not
used, and the absence of a style among favorites is never read as dislike (a unit test adds 40 non-favorite images and
asserts that the profile does not change by a single digit).

- Each favorite's position on the twelve qualities is measured **against the reference collection** (z-score relative to
  typical art), so the result does not depend on library composition.
- **Separate preferences:** favorites are grouped by k-means (k = 1 to 6, best of 4 restarts, chosen by silhouette). A split
  is accepted only if every group has at least 4 images, the silhouette is at least 0.10 **and every pair of group centres has
  cosine similarity below 0.90** (groups carved out of one coherent set always have nearly identical centres; this removed
  false splits in tests). Otherwise the favorites are one group.
- Each group shows its own images, the qualities it reliably leans towards (99% bootstrap interval excludes zero, at least
  5 images, effect at least 0.3 standard deviations), and the **reference works that look closest to it**, with their museum,
  credit and link. These are visual resemblances; the page says it is not a claim about influence.
- Small libraries: three favorites are enough to start; with fewer than 5 images per group no quality is claimed, and the page
  says the picture is tentative.

### My Discovered Taste (`src/main/discovery.ts`, `tasteFeatures.ts`)

**Answers** (all recorded, all different): prefer A, prefer B, **like both**, **like neither**, **can't decide**. Preferences are
pairwise logistic terms (the existing Bradley–Terry model); "both" is a positive point for each work, "neither" a negative one;
"can't decide" is recorded (so the pair is not shown again) but carries no taste information. Journey reactions are single
likes, dislikes and saves.

**Model.** The existing linear model is kept and extended: each work is described by its embedding **plus its similarity to 160
landmark works** spread across the collection (a Nyström-style radial-basis feature map). The model is still linear in these
features: convex, deterministic, trained in about 0.1 s, with the same loss, but it can place several separate peaks of
preference. Hyperparameters (kernel width, regularisation, feature scale, landmark count) were swept on recorded answers; the
differences were small (AUC 0.81 to 0.83 at 100 answers), so a mid-grid setting was chosen (λ = 1, γ = 8, scale 1.5).

**Separate tastes stay separate.** The works the user liked are grouped into directions with the same rule as identity; each
direction is described against what the user was *shown* (not the whole collection), so a pair-selection bias cannot masquerade
as taste.

**What is shown, and why** (`nextPair`): the collection is **mapped first**: typical works of different regions are compared until
three quarters of the regions have been seen (at least 14 answers); after that pairs mix **sharpening** (the model is least sure),
**looking closer** (two works near something the user likes), **testing something new** (a work far from everything seen, above
the median predicted appeal, against something the user likes) and more mapping. Pairs are mostly like with like (painting with
painting, 75%) so a choice is about the work rather than the medium. Near-duplicates (similarity above 0.93) and repeated pairs
are never offered; works are shown **without names** and named afterwards, so answers are about how they look.

**Accuracy** is cross-validated on the user's own earlier answers and appears after 20 answers.

#### Simulated users on the real collection

Users are defined by museum shelves they like (metadata the model never sees); 20% of works on a liked shelf are "not to their
taste"; answers are noisy (e.g. "both" is given 80% of the time when both are liked). Ranking quality (AUC, 0.5 = chance):

| User | Share liked | Answers | Existing linear model | Mixed model | Top 24 unseen suggestions to their taste |
| --- | --- | --- | --- | --- | --- |
| Two overlapping tastes (landscape + prints / prints + Asian) | 11% | 40 / 100 | 0.741 / 0.829 | **0.776 / 0.875** | 54% (5.1×) |
| One taste (baroque, Renaissance, portrait) | 7% | 40 / 100 | 0.886 / 0.915 | 0.892 / **0.918** | 50% (7.0×) |
| A small specialised taste (ukiyo-e only) | 2% | 40 / 100 | 0.968 / 0.988 | **0.989 / 0.989** | 29% (13×) |
| Three unrelated tastes (landscape / architecture / abstraction) | 16% | 40 / 100 | 0.697 / 0.692 | **0.742 / 0.756** | 46% (2.9×) |

The extension is never worse than the existing model and helps most where tastes are several and different, which is the case it
was built for. **A known weakness:** in the three-taste user, the third taste (abstraction + modern sculpture + early modern
painting) is not learned: it is defined by shelves, not by appearance, and is visually heterogeneous, so a model that works from
how images look has nothing to generalise from. A person whose taste is visually coherent does not have this problem.

## Comparing the profiles (`compare.ts`)

One row per **axis** (its two poles are mirror images): the favorites' lean and the discovered lean side by side with 99%
intervals, a relation (agree, favorites only, discoveries only, differ, unclear) and a sentence that names the pole the evidence
points to and states how thin the evidence is ("only 7 favorites, 12 exploration answers so far"). The **map** draws the whole
collection (UMAP of the embeddings), the user's favorites (placed by their closest reference works), liked and passed-on works,
and the 22 regions coloured by status: shared, in favorites only, discovered only, **promising but little explored** (a
prediction from the model, never presented as fact), passed on, unexplored. Selecting a region lists its numbers and example
works and offers a journey.

## Journeys (`journeys.ts`)

A journey has five chapters: **Where you are** (the closest works), **Neighbouring traditions** (close but from other shelves and
cultures), **the same quality in other worlds** (the seed's strongest reliable quality, in works that otherwise look different),
**Beyond what you have told me** (a deliberate stretch outside regions the user has confirmed) and **A contrast** (the opposite
pole, so the sense of the quality sharpens either way). Seeds: a tour of the whole collection (no personal data), a discovered
direction, a group of favorites, an emerging direction (discovered, with nothing close among favorites), a little-explored region,
or a single work ("more like this").

**Honesty rules.** Every explanation is a measured fact (visual similarity, a quality's z-score, predicted rank with the model's
measured accuracy) or museum metadata (same maker; same culture in another medium). The text never says that one artist
influenced another (a test searches for it). Each journey states its basis ("built from 30 of your answers…") and what share of its
works lie outside confirmed regions.

**Filter bubble.** Every personal journey contains stretch chapters; in the real-app test 41 to 63% of the works were outside
confirmed regions. Reactions feed the model, so a stretch that fails teaches as much as one that succeeds.
*Measured:* pooled over the four simulated users, **4 of 95 stretch works** were to the user's taste, against **2.7 expected** from
random works outside the confirmed regions (about 1.5×). Stretch is exploration, not recommendation; its hit rate is low and it
is presented as a gamble.

## Taste evolves (`history.ts`)

A snapshot stores both profiles as they were (qualities with their evidence, number of groups, counts), whenever 8 more answers or
3 more favorites have accumulated (and weekly if anything changed). Snapshots are append-only, so they survive un-favoriting and
"start over". On a library with dated favorites, earlier snapshots are **reconstructed** month by month from `favorite_at` and
labelled as such. The history view shows each quality over time and lists the discoveries (chosen, liked or saved) between
snapshots, with the caveat that they coincide with changes and are not proven to have caused them.

## Keeping unlike images out (`guard.ts`)

Classic library comparisons now leave out screenshots and technical images: an image is excluded when its "technical" score
(similarity to descriptions such as "a screenshot of a computer screen") minus its "finished artwork" score exceeds the
**99.5th percentile of the reference artworks**. The yardstick is data, not a guess; without it nothing is excluded. In the
real-app test all 3 synthetic screenshots (plus 1 more) were excluded and none was ever offered.

## Verification

- **Unit and engine tests**: 77 tests (`npm test`), including 20 for the discovery system on a synthetic collection (pack loading
  and corruption, every answer type, mapping first, no repeated pairs, undo/reset, three tastes kept separate, no claims from
  random answers, identity ignoring the rest of the library, small libraries, comparison statuses, journey structure and
  stretch, feedback as evidence, history, saving with provenance and untouched originals, the guard).
- **Simulated users on the real collection**: `tests/discovery-sim.test.ts` (table above).
- **Real application** (`scripts/e2e-discovery.mjs`, development build and the packaged Windows app): a 69-image library made of
  artworks of known kinds plus screenshots; a simulated user explores with all five answers through the real interface;
  both profiles, the comparison, a journey (viewing, reacting, saving as favorite, saving to a moodboard), history, restart
  persistence, the classic compass and its guard, every other room, and a hash check that none of the user's own files changed.
  `scripts/e2e-discovery-offline.mjs` repeats the essentials with **no image model and no library**.

## Limits and next steps

- The collection is small and American-museum-centred (see [REFERENCE-COLLECTION.md](REFERENCE-COLLECTION.md)); a larger,
  more international pack would make suggestions and journeys richer.
- Stretch works help exploration but are mostly misses; a smarter policy (for example bandit-style exploration across regions)
  is an open research question.
- The twelve qualities use English descriptions and SigLIP; a quality can be imperfectly named (examples are shown so it can be
  checked). User-defined dimensions would capture taste these words do not.
- Journeys are assembled from measured similarity and museum metadata. There is no curatorial or art-historical text, by design,
  because none can be generated without inventing it.
- A cloud model for richer narration is possible later and stays optional; nothing here needs one.
