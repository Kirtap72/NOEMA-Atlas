# The Smart Organizer and looking at pictures

Two capabilities that work together with the Atlas Companion:

1. **Smart Organizer** – analyses a large set of pictures and proposes a folder structure you can refine, then **copy or move** to a folder you choose. You tick the groups you want; only ticked groups are included, and nothing ticked means nothing is selected.
2. **Looking at pictures** – lets a vision-capable language model look at the pictures themselves, with clear labels on what it saw and what comes from library notes.

Reading, grouping and proposing never move, rename, overwrite or delete an original. Only an explicit **Move** that you confirm relocates files (and then Atlas keeps their library records); **Copy** leaves every original where it is.

---

## Smart Organizer

Open **Smart Organizer** under CURATE in the sidebar, or ask the companion (“organize my Holiday folder”).

### 1. Choose what to read

The whole library, or only some sources (the folders and drives added to Atlas). Choose a folder layout and what to do with copies and versions; both can be changed later. Reading takes a while for large collections. It runs in the background in batches, so it can be **paused, resumed, and survives closing Atlas**: unfinished work continues where it stopped.

### 2. What Atlas works out

| Step | How |
|---|---|
| Exact copies | Files of the same size are compared by SHA-256. |
| Kind of picture | *Finished artwork*, *Photographs*, *Experiments*, *Screenshots and technical images*, *To review (uncertain)*. From the curation roles (file names such as 3D software, resolution, text), from the image model (SigLIP) comparing each picture with plain descriptions, and from the picture’s own **camera data (EXIF)**. |
| Subject and style folders | Pictures of each kind are grouped by visual similarity (the same grouping as Families). Each group is named from what its pictures share; a large group with no common thread is split once more. A group Atlas could not name says so (“Mixed images”), and every group shows how sure it is. |
| Copies and versions | Exact copies; near-identical pictures (very similar look and same shape); versions of one another (similar look and related file names such as `_v2`, `(1)`, `_upscaled`). Each group suggests the best version and says why (resolution, your favorites, rating, file size). |

**What the kind labels mean, honestly.** A *photograph* is a picture with camera data. A picture that merely *looks* photographic but has no camera data goes to **To review**: it can be a real photo whose details were removed, or a realistic generated image, and the image model cannot tell the two apart. One button treats all of them as artwork or as photographs. Screenshots, diagrams, maps and sheets of test renders are recognised from how they look as well as from file names. The thresholds were checked against a real library (see “What was verified”), but they are judgments, not facts, and Atlas shows its reason for each decision.

If the image model is off or not installed, pictures are grouped from file facts only (type, size, date, name), and the page says so.

### 3. Refine

On the page: rename a folder, merge folders, leave a kind out, add your own category (a name and a description such as “cats and kittens”), change the layout, choose how copies and versions are handled, treat all “To review” pictures as artwork or photographs. Or by talking to the companion: *“Merge the two landscape folders and call it Landscapes”*, *“Leave out the screenshots”*, *“Add a category for cats”*, *“Put everything in year folders”*. Changes apply to the plan only.

Layouts: **Kind / Subject** (default), Subject, Year / Subject, Kind only, All in one folder. Working images and “To review” are never mixed into subject folders.

Copies and versions: **set apart** (the best stays where it belongs, the rest go to “Duplicates and versions”), **copy only the best**, or **keep every version together**.

### 4. Choose what to include

Every folder (group) has a **checkbox**. Check the folders you want; **only checked folders are included** in the copy or move, and unchecked folders never are. The page says how many folders, pictures and bytes are checked (*Check all* and *Check none* are there too). **With nothing checked, nothing is selected** (an empty selection is never read as “everything”): the page and the preview say so, and **Copy and Move are disabled** (and refused if requested directly) until you check at least one folder or press *Check all*. A renamed or merged folder stays checked under its new name; the same checks pick the folders to *merge*. Clicking a thumbnail opens that folder's pictures (or the members of a set of copies) in the picture viewer, to look at and compare; it never changes what is checked.

### 5. Copy or move

Choose **Copy** (the originals stay where they are) or **Move**. Choose a destination (it cannot be inside the pictures being organized). Before anything happens Atlas shows:

- what is included (the checked folders), how many files will be copied or moved and how many bytes, against the **free space** at the destination (a same-drive move normally shares the existing file data. A filesystem without hard links can require room for a copy);
- every operation (source → destination), in pages;
- **Name conflicts** get numbered names such as `photo (2).png`. Atlas skips an existing destination file only after its size and SHA-256 match.

**Move** relocates the originals and keeps their place in the Atlas library, because each record is pointed at the new path instead of being replaced: favorites, ratings, moodboards, versions and the Studio's history stay with the picture. On filesystems that support it, Atlas creates an exclusive hard link before changing the catalogue and removing the old name. Otherwise the file is copied, compared byte for byte, recorded in the library, and only then removed from its old place; if the old file cannot be removed the picture is safe in both places and the report says so. Every step can be repeated after an interruption; an original that is missing, changed, or whose destination name is taken by a different file is reported and left alone. The destination folder becomes a source of its own, so the moved pictures stay in the library.

Copying uses a uniquely named temporary file and exclusive destination creation, a **journal** that lets it continue after a pause, a crash or closing Atlas, and a **check of every copy** (size, or full SHA-256 if you choose; a move always compares full content across drives). A report lists what was copied or moved, renamed, skipped or failed. The companion can only *offer* the export; you choose the folder and press Copy or Move on the page.

---

## Looking at pictures

With a language model that can see, the companion can look at your pictures directly (“Look closely at these three artworks and tell me what could be improved”, “Compare these versions”). Pictures are sent as at most six JPEGs of up to 1568 px, from the original files; “look closer” and “this corner” send crops at higher detail.

### Consent

- **A model on this computer** (Ollama, LM Studio, or anything on `localhost`): pictures are attached immediately; they never leave the computer.
- **A cloud model**: the companion shows a request naming the pictures and the provider. **Nothing is read or sent until you press Accept**, and then only those pictures, once. Ask again and you are asked again.
- **Basic mode** (no language model): the companion says it cannot look at pictures and does not pretend to.

### What you see

When the model has looked, the answer starts with a **“Looked at these pictures”** block showing which pictures, with which model, and whether it ran locally. Paragraphs about what it **saw** are labelled *Seen*; paragraphs based on library notes, tags and your taste are labelled *Library*; suggestions are labelled *Idea*. A model that cannot tell something from the pictures is instructed to say so. To act on something it saw, the companion proposes a retouch or an edit as usual; it never claims to have changed anything.

The same machinery serves Taste profiles, Smart Collections, moodboards and the Studio: pictures are referred to by short references, a moodboard can be named instead of listing pictures, and a result can be turned into a retouch or edit proposal.

---

## What was verified

**Unit tests** (`tests/organizer.test.ts`, `tests/organizerTools.test.ts`, `tests/vision.test.ts`): folder naming and placement, conflict numbering, destination checks, duplicate groups and best choice, camera-data reading from real EXIF, kind rules, refine operations, pause/resume and interruption of analysis and of the copy, copy verification, originals unchanged; companion tools; the wire formats of the three providers with pictures; that a cloud model gets nothing before consent, only the approved pictures afterwards, and **once**.

**The real image model on a real library** (copy of the library database, 509 pictures, nothing on disk touched): analysis took 15–17 s. Screenshots, diagrams, maps and test-render sheets were found by their look (about 93 of them, checked by eye on contact sheets); the group names are mostly descriptive, with a few honest “Mixed images”. Real camera photographs (iPhone, Samsung, Canon files from a photo folder) were classed as photographs from their EXIF data; realistic generated pictures without camera data went to “To review”, which is by design (see above).

**The packaged app** (`node scripts/e2e-organizer.mjs --exe "…/NOEMA Atlas.exe"`, also passes unpackaged): a 36-picture library (artwork, camera photographs, screenshots, an exact copy, an upscaled version) organized through the companion and the page; refined on the page and through a model on this computer; export offered as a request; the copy to a folder that already held a clashing file and another file: preview with bytes, free space and conflicts, 32 files copied and verified, 1 renamed, the existing files untouched, every copy byte-identical, the left-out kind not copied, no temporary files left, **all 36 originals unchanged**. Pictures: a local model got three real JPEGs (≤1568 px) with a “Looked at directly” block and *Seen*/*Library* labels; a model not on this computer got nothing until “Send these pictures” was pressed, then exactly one request carried them.

## What was not verified, and limits

- **No real vision model was run.** No local vision model is installed (Ollama has none), and no cloud vision model was called. The picture path was exercised against a mock OpenAI-compatible server that decodes the images it receives. The Anthropic and OpenAI Responses formats are covered by unit tests only. Nothing was downloaded without consent.
- **Kill-and-resume was tested in unit tests (an interrupted engine continues from its saved state), not by killing the packaged app.** The e2e libraries are too small to interrupt reliably.
- **Scale:** 509 real pictures were analysed in about 16 s with embeddings already made. Thousands are handled in batches with state in SQLite, but no run on tens of thousands was made. Embedding pictures the image model has not yet read is the slow part, and happens in the normal indexing.
- **Photograph or generated picture** cannot be told apart from how it looks. Camera data is the evidence; without it the picture is “To review”.
- The thresholds were tuned on one person’s library (mostly AI-generated pictures plus some real photographs). Other libraries may need different thresholds; each decision shows its reason.
