# Taste Compass: architecture and evidence

*NOEMA Atlas 1.4.0. First version of the personal taste model ("Smakkompassen").*

## Goal and constraints

Learn which visual qualities a person likes from **their own choices**, recommend unseen images from their library, and
show the profile as an interactive circular chart with understandable dimensions and example images. No arbitrary AI
verdicts: every number on screen must trace back to something the user chose, and the model must improve with more
choices. Everything runs locally on the SigLIP vectors Atlas already stores (768 numbers per image).

## Signals (what the model may learn from)

| Signal | Used for | Weight |
| --- | --- | --- |
| **Pairwise choice** ("which do you prefer?") | model, compass, accuracy | 1 |
| Keep vs Pass decisions (existing Review Room data) | model, compass | 0.5 (up to 300 sampled Keep-over-Pass pairs) |
| Star ratings (rating gap of 2 or more) | model only | 0.35 (up to 150 pairs) |
| "Can't say" | nothing, but the pair is not offered again | 0 |
| Unreviewed images | never treated as dislikes | none |

Pairwise comparison was chosen over star-rating a stream of single images because relative judgements are faster, steadier
and avoid each person's personal rating scale. Keep/Pass and ratings already exist in Atlas, so a returning user starts
with a head start, clearly labelled as inferred.

## Model: Bradley–Terry on the embeddings

`P(a preferred over b) = sigmoid(w · (xa − xb))`, fitted by L2-regularised logistic regression (accelerated gradient
descent, λ = 0.1, 250 iterations; about 0.1 s for 500 pairs). An image's taste score is `w · x`. Properties that matter:
it is convex (no bad local optima), deterministic, trains in milliseconds, is retrained from the saved choices on demand
(nothing opaque is stored), and gives a calibrated "which of these two" probability.

### Alternatives measured (simulated users on a 6,000-image sample of a real 28,500-image library)

Simulated users choose with Bradley–Terry noise (they pick their preferred image about 85% of the time on typical pairs).
Held-out accuracy on 1,500 pairs with a clear difference, by number of random comparisons.

*Experiment 1: four users defined by text descriptions the app does not know (dark/moody, bright abstract, people, surreal
landscape):*

| Method | 5 | 10 | 20 | 40 | 80 | 160 |
| --- | --- | --- | --- | --- | --- | --- |
| **Logistic, full 768-d, λ = 0.1 (chosen)** | 63 | 67 | 72 | 75 | 79 | **82** |
| Mean(winners) − mean(losers) ("centroid") | 63 | 66 | 72 | 73 | 73 | 76 |

*Experiment 2: eight users (those four plus four defined by five favourite images each), feature spaces compared:*

| Features | 5 | 10 | 20 | 40 | 80 | 160 |
| --- | --- | --- | --- | --- | --- | --- |
| **Full 768-d embedding, λ = 0.1 (chosen)** | 66 | 70 | 73 | 75 | 81 | **85** |
| 16 PCA components | 60 | 66 | 73 | 74 | 79 | 82 |
| 32 PCA components | 66 | 70 | 73 | 75 | 81 | 84 |
| 32 / 64 whitened PCA components | 57–59 | 60–63 | 63–67 | 67–71 | 74–79 | 79–83 |

Reducing the dimension did not help (the embedding already is the useful low-dimensional space) and the centroid shortcut
was clearly worse. Regularisation strength mattered little between 0.1 and 1.

### Choosing which pair to show (active learning)

- **Random-ish first.** For the first 20 choices Atlas shows clearly different pairs from rarely shown corners of the library.
  Uncertainty sampling from the start was measurably *worse* (model accuracy 39–57% at 5–20 choices): with too little data,
  "the pair the model is unsure about" is arbitrary.
- **Then uncertainty sampling, mixed with random pairs.** Afterwards, half of the pairs are the ones whose predicted margin
  is smallest, half are random. Mean accuracy over the same simulated users after 20/40/80/160 choices: random 75.5 / 77.7 /
  80.5 / 84.1; this mix 75.5 / 77.8 / 81.7 / 85.5. A modest, consistent gain, plus better coverage of the library.
- Near-duplicates (cosine above 0.95) are never offered, recent images and already seen pairs are avoided, and
  every pair is recorded with how it was picked.

### Evaluating honestly

Atlas shows **cross-validated accuracy**: 5-fold, train on 80% of the user's choices, predict the other 20%, repeated. It
appears after 15 choices and is described as "tested on your own earlier choices (guessing gives 50%)". A user choosing at
random gets about chance (40 to 60% in the real-app test), so the number cannot be inflated.

## Recommendations

Score every learned image with `w · x`, remove images already shown, Kept or Passed, then take the top ones greedily while
skipping near-duplicates (cosine above 0.9) so one picture does not fill the list. Each suggestion shows its **percentile
in the library** (not a made-up probability) and **the image you chose that it most resembles**.

## The compass: understandable dimensions, measured from choices

Six axes, each with two opposite poles (12 petals): Reality (surreal ↔ natural), Form (abstract ↔ figurative), Mood
(romantic ↔ stark), Light (dark ↔ bright), Colour (vivid ↔ muted), Composition (minimal ↔ rich).

1. Each pole has three short English descriptions (for example "a dark, moody, low-key image"). Their text embeddings are
   averaged. An **axis direction** is the difference between its two poles, so shared meaning (both are about light) cancels
   and the poles are true opposites.
2. Every library image gets a **z-score** along each axis (how far along it is relative to the rest of the library).
3. **Lean** = the mean of (z of the image you chose − z of the image you passed over) across your comparisons. Positive means
   your choices sit towards that pole. It is a direct measurement of choices, not a prediction.
4. A **99% bootstrap interval** (500 resamples) says whether the lean is more than chance. A petal is drawn solid only when
   the interval excludes zero and at least 6 decisions exist; otherwise it is drawn faint and dashed. The wide interval is
   deliberate: six axes are tested at once.
5. Petal length is `0.5 + 0.5·tanh(lean / 0.5)`. The dashed ring (0.5) means "same as the images you passed over". Because
   each axis uses one direction, a long petal on one pole implies a short one on the opposite pole.
6. Selecting a petal shows plain-language evidence ("in 38 of 54 clear comparisons you chose the image with more of it"), the
   range, images **you chose** that show the quality most, and **what the quality looks like in your library** so the label
   can be judged by eye.

**Bias control.** Pairs picked *because the model was unsure* are a biased sample (both images have similar overall appeal, so
their difference on any one quality is dampened). They are used to train the model but **excluded from the compass**, which
uses only warm-up, exploratory and random pairs plus Keep/Pass. The page shows how many comparisons feed the compass. Before
this fix, a simulated user's lean shrank from about 0.5 to 0.34 as more adaptive pairs were added; afterwards it grew with
evidence and became reliable at about 100 choices.

**What it does not claim.** The descriptions are only measuring sticks for pictures; the profile describes what the user
picks, never whether a taste or an image is good. Labels are English prompts interpreted by SigLIP, so a quality can be
imperfectly named (the on-screen examples are there to let the user check).

## Verification (real application)

`scripts/e2e-taste.mjs` drives the real interface (keyboard and mouse) on a 441-image library with simulated users whose
taste is defined by the app's own visual search:

- A new profile is empty and every petal is faint.
- **30 random choices** produced no confident petal and chance-level predictions (40 to 57%).
- **A user preferring dark, moody images**: the Dark axis leans the right way after 40 choices (+0.4 to +0.65), becomes reliable
  somewhere between 60 and 160 choices depending on the run (for example lean 0.63, interval 0.12 to 1.08 at 100; lean 0.96 at 60),
  accuracy on own choices 62 to 79%; suggested images rank in the user's top 20 to 34% on
  average (random: 50%).
- **An inverted user** reverses the compass; skip, undo and start over work; 60 choices survive a restart; every other room
  and visual search still work. Unit tests (`tests/taste.test.ts`) cover the maths and the engine on synthetic data.

## Known limits and next steps

- 12 qualities is a first vocabulary; user-defined or learned dimensions (from their own favourites) would capture taste that
  these words miss.
- Certainty takes on the order of 100 to 150 choices for a moderately consistent, noisy taste; fewer for a strong one.
- The model is linear in the embedding. Multi-modal tastes (one person liking two unrelated styles) are better served by a
  mixture; the compass already shows the average lean only.
- Art-historical comparisons, LoRA training and the assistant build on this profile and are not part of this version.
