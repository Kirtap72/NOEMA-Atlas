# The Creative Studio

*NOEMA Atlas. Builds on the Atlas companion ([ASSISTANT.md](ASSISTANT.md)), the Taste Compass and Atlas moodboards.*

The Studio turns what Atlas knows about your visual world into new work. A moodboard becomes a concept, the concept
becomes a prompt you can read and change, the prompt becomes pictures that come back into your library linked to their
sources, and any picture can be varied, refined or edited into a new version. Originals are never changed.

## From moodboard to artwork

Open a moodboard and press **Create artwork**.

1. **Say what each picture is for.** Every picture on the board has four small buttons: *Atmosphere*, *Composition*,
   *Colours*, *Subject*. A picture can do several things. With no choices, the whole board speaks for everything.
2. **Say what you want**, in your own words: "A new surreal landscape. The atmosphere of the prints, the composition of
   the first picture, the colours of the architecture."
3. **Develop the concept.** Atlas reads the board (the colours it measured, and what the local image model sees: mood,
   style, subject) and writes a prompt, an "avoid" list, a palette and three other directions. It tells you in plain lines
   how it understood each role. Nothing here leaves your computer.
4. **Review and edit the prompt.** The prompt is yours. Nothing is made until you press *Make the artwork*.
5. **Choose how to make it.** See below. The price is shown before anything is made.
6. **Results arrive in the Studio as they finish**, are saved in your library (in the Studio folder, which Atlas keeps as
   a source), thumbnailed like any image, and are linked to the moodboard and to the pictures that shaped them.
7. **Variation, Refine, Add to board, Edit.** *Variation* makes a sibling from the same starting point. *Refine…* starts
   from a result with a slider for how far to move away from it. Everything made from one idea is one *series*;
   open any picture in the viewer and "Where this came from" shows the moodboard, the source pictures with their roles,
   the prompt, and the whole series.

The companion can start this too: ask "Create a new surreal landscape from my "Quiet Valleys" moodboard". Atlas drafts a
concept and shows it as a proposal; **Open in the Studio** hands it over. Accepting a proposal never makes or pays for
anything.

## Methods (modular)

A method says what it can do, whether it is available right now (and why not, in plain words), whether anything leaves
your computer, and what it costs. Adding another backend means adding one class; the Studio does not care which one
makes the picture.

| Method | What it is | Leaves the computer | Cost |
| --- | --- | --- | --- |
| **Atlas Blend** | Offline, no AI model. Takes the composition of one reference, re-colours it with the palette of another, lays the atmosphere of a third over it and grades it towards the mood in the prompt. Deterministic per seed. It is a colour-and-composition *study*; it does not invent new subjects. Also edits: mood grading that moves pixels not at all. | No | Free |
| **ComfyUI** | Real AI image making with your own models and workflows, through ComfyUI's local HTTP API. Standard text-to-image graph (checkpoint, sampler, VAE) and image-to-image for variations and edits. Or your own workflow file (below). | No (only your own ComfyUI) | Free |
| **OpenAI images** (optional) | Paid cloud image making (`gpt-image-1`, `dall-e-3`). | Yes: the prompt. For edits, also the picture. | Estimated per picture, limited by your monthly cap |

### ComfyUI

**Setting it up once.** Open the Studio settings, choose **Choose my ComfyUI folder**, and pick the folder you already
have. Atlas recognises three layouts: the *portable* download (a folder with `python_embeded` and `ComfyUI`), a *source*
install (a folder with `main.py`, with or without a virtual environment) and the *Desktop app* (`ComfyUI.exe`, whose
models normally live in a separate base path that Atlas reads from the app's own settings). If you have not chosen yet,
installations Atlas finds in the usual places are offered. A folder that is not ComfyUI is refused with a plain reason.

**What Atlas reads.** From that folder Atlas reads the models (checkpoints, diffusion models, VAEs, text encoders, LoRAs,
ControlNets, upscale models, including folders listed in `extra_model_paths.yaml`) and the workflows in
`user\default\workflows`. It tells which workflow makes pictures, edits a picture or enlarges one, and which of its models
are missing, with the file name and the ComfyUI folder it belongs in. Workflows for video or sound are not offered.
Nothing is written to your ComfyUI folders: not models, not workflows, not settings.

**Starting.** When you make a picture and ComfyUI is not running, Atlas starts it from the installation (the portable
and source layouts with their own Python, the Desktop app by opening it) and waits until it answers, showing progress.
If ComfyUI is **already running** (on 8188, 8000 or the address you set), Atlas connects to it and does not start
another. Atlas closes only a ComfyUI that **it** started, when you press *Close ComfyUI* or when Atlas quits; one you
started stays exactly as it is. If the usual port is taken by another program, Atlas picks a free one. Start-up
problems are explained in plain words: another program using the address, no usable graphics card, a missing Python
package, a program that was moved, or a start that takes too long.

**Your workflows are used as they are.** Pick the workflow Atlas should use to make pictures, to edit and to enlarge.
Atlas fills in the description, the negative description, the seed, the size and the starting picture where your graph
expects them, and leaves everything else (sampler, steps, models, LoRAs) as you set it. Workflows saved by the editor
are converted using the running ComfyUI's own node definitions; workflows exported with *Export (API)* run directly.
An **upscaling workflow** runs on a copy of a picture and comes back as a new version, linked to the original. Your
workflow files and your originals are never changed. With no workflow chosen, Atlas uses its standard graph with the
first checkpoint it finds.

**If something is missing**, the settings say so in simple language: for example that ComfyUI has no checkpoint and
which of your workflows is only missing one file.

**Project layouts, ports and other Pythons.** Not every installation is a download folder. A project can keep ComfyUI
and its virtual environment side by side (`runtime\ComfyUI` and `runtime\venv`), start it on its own port, and keep its
workflows elsewhere (`presets\clarity\<name>\workflow_api.json`). Atlas finds the Python beside the installation, reads
(never runs) start scripts next to it (`start_comfy.ps1`, `.bat`, `.cmd`) and takes their port and start options, and
offers workflow folders such as `presets`. When a port is set, Atlas connects **only** to that port, so another
ComfyUI on the usual port is never borrowed by mistake, and refuses to start on a port that another program holds. The
settings (**How Atlas starts it, and where your workflows are**) let you change the Python, the port, the start
options and the workflow folders. Start options that would change Atlas's address or port (`--listen`, `--port`, …) or
contain shell characters are refused. A project's Python is started the way its scripts do it (user-site packages off,
caches beside the project). Workflows are listed by their folder's name; the editor copy `workflow_ui.json` beside a
runnable `workflow_api.json` is not listed twice. An **enlarging workflow runs exactly as tuned**: Atlas gives it the
picture and nothing else (seed, descriptions and strength stay yours), and returns the real result, not a baseline
picture saved on the way. If a workflow uses a custom node that is not installed, Atlas names the node before running.

**Advanced.** You can still give an address (a ComfyUI on another port) and a single workflow file with placeholders:
export with **Save (API format)** and put `{{prompt}}`, `{{negative}}`, `{{seed}}`, `{{width}}`, `{{height}}`,
`{{checkpoint}}`, `{{denoise}}`, `{{image}}` where Atlas should fill things in. `{{image}}` makes Atlas upload the
starting picture (the parent of a variation, or the composition reference) to ComfyUI's input folder, which is local.

### Cost and consent

* Cloud methods are off until you add a key **and** set a monthly limit above zero. A limit of 0 keeps paid services off.
* Before every cloud request the Studio shows the estimated price and what will be sent, and the Make button stays
  disabled until you tick the agreement. The main process checks this again: a request whose price exceeds what you
  approved, or that would pass your monthly limit, is refused before any network call.
* For new pictures only the prompt is sent, never reference pictures or paths. An edit sends the picture, and says so.
* The key is stored encrypted by the operating system's key store (not in the settings file), like the companion's keys.
* Prices are estimates for budgeting, not invoices.

## Setting up AI (Studio settings → “How should Atlas make pictures?”)

Atlas never needs Python, a ComfyUI folder or a manual download. There are three ways, all optional:

1. **Use my ComfyUI.** Choose your existing ComfyUI folder once. Atlas reads it, starts it when needed and stops what it
   started. It never writes into it. Models Atlas would like to use but that are missing are reported, not added.
2. **Let Atlas install its own.** Atlas installs a separate ComfyUI in a folder you choose (it suggests the roomiest
   non-system drive and refuses a non-empty folder it did not make). It reads your graphics card first and says
   what it found. Installation starts only after you tick the consent box, and shows the download size, the disk it will use and
   the licence. The steps: download the official portable ComfyUI from GitHub (resumable, checked against its published
   SHA-256), unpack it with the tar that ships with Windows, write one models-path file inside Atlas's own runtime, start it once
   to check that it answers. Everything lives under `<folder>\runtime`, `models`, `work` and `downloads`; models live
   outside the runtime so updating never moves them.
3. **No ComfyUI.** Atlas Blend and plain enlarging keep working; paid cloud pictures can be added with a key and a monthly
   limit, always asking first.

### Capability packages (only for Atlas's own ComfyUI)

| Package | Adds | Download | Needs | Licences |
| --- | --- | --- | --- | --- |
| Create pictures | Stable Diffusion 1.5 (fp16) | 2.1 GB | 6 GB graphics memory | CreativeML Open RAIL-M |
| Edit pictures | ControlNet “tile” (keeps composition) | 0.7 GB | Create | CreativeML Open RAIL-M |
| Creative upscaling | Real-ESRGAN x4 plus a detail pass | 0.07 GB (+ Edit) | 8 GB graphics memory | BSD 3-Clause, Open RAIL-M |

Each file has its size and SHA-256 pinned in Atlas and is verified before it is used; a failed check throws the file away.
Downloads continue where they stopped after a dropped connection, a Stop, or a restart. **Update ComfyUI** installs the newer
version next to the old one, starts it to check, and only then switches; if it fails Atlas switches back and the old version
is untouched (previous versions are kept until you remove them). **Remove Atlas's AI** deletes only what Atlas installed.

### What Atlas offers when something is missing

Everything asks the same question, “what can be done here?”, so the Studio, the viewer and the companion agree:

* The **Edit** tab is always usable (earlier, it stayed disabled until a picture was opened from elsewhere). Without a
  picture it shows a picker. A banner says what is possible with the picture (“ComfyUI, keeping the structure”) or exactly
  what is missing, with **Set up…** next to it. Unavailable methods offer **Set this up…** instead of greying out.
* The companion has `studio_capabilities`, `propose_edit` and `propose_upscale`. Offline it understands “what can you
  create?”, “make it more mysterious” and “upscale this to 2048” about the picture it just showed. It only proposes;
  accepting opens the Edit tab or the Upscale panel with everything filled in, and nothing is made until you press the
  button there.

### Atlas's own graphs

When the models are present (Atlas's own, or a connected ComfyUI with the same kinds of file) Atlas uses graphs built
only from nodes that ship with ComfyUI: **structure-keeping edit** (tile ControlNet at a strength you set), **detail
upscaling** (Real-ESRGAN, then a gentle low-denoise pass held by the tile ControlNet; detail passes run up to 2048 px on the
long side, larger sizes get the enlargement only) and, for creation, the standard text-to-image graph at Stable Diffusion
1.5's own size (about 768 px; enlarge afterwards). Your own workflows, **Clarity presets included, are always run exactly
as tuned** and are never modified; they are preferred when chosen.

## Looking closely: the large viewer, Upscale and Compare

Click any made picture in the Studio (or press **Enlarge…** in the ordinary picture viewer) to open it large, at its real
resolution, not the thumbnail.

* **Fit** (F) shows the whole picture; **100%** (1) shows one screen pixel per picture pixel. The mouse wheel zooms around
  the pointer, dragging pans, double-click goes between fit and 100% on the spot, **+** and **-** zoom in steps. Zoomed far
  in, pixels are shown as pixels, never smoothed.
* **← / →** step through the picture's series: its variations, edits and enlargements. A strip along the bottom shows them.
* **Upscale** makes a larger copy. Choose **how**: a plain enlargement (smooth resampling, adds no new detail, needs
  nothing installed), or any ready ComfyUI upscaling preset, including your Clarity presets. Choose the **size** with 2×, 3×,
  4× or type the longer side in pixels; the panel shows the exact result and refuses sizes the computer cannot hold.
* For a ComfyUI preset the workflow runs as you tuned it. The one exception is the scale step that follows the upscale model
  (an `ImageScaleBy` after an `ImageUpscaleWithModel`): it is set from your target so the picture comes out at that size.
  Whatever size ComfyUI actually returns, the result is resampled to exactly the size you asked for, and the saved note
  records both. Your workflow files, the presets and the original are never modified, and detailed presets can take many
  minutes on large pictures (Atlas shows the time, and Stop works).
* The result is saved as a new version in the Studio folder, linked to its source and series, and the viewer opens the
  original beside it.
* **Compare** (C) shows two pictures side by side. Zoom and drag in either pane move both, so you judge real detail at the
  same spot. *Same area* shows both covering the same part of the scene (the smaller picture is magnified, so its real pixel
  detail is visible next to the larger one's); *Actual pixels* shows each at 100% of its own pixels. You can compare with any
  picture in the series.

## Editing a picture

Open a picture and press **Edit…** (or from a result). Describe the change: "Make the atmosphere more mysterious, but
preserve the architecture and composition." Choose how strongly, and a method.

* A **preview** is made first and kept only in memory. **Keep as a new version** saves it next to the original and links
  it to its source; **Discard** leaves nothing behind.
* Atlas Blend understands moods and looks (English and Swedish): mysterious, misty, dreamy, warmer, cooler, brighter,
  more vivid, muted, black and white, film grain, dramatic, surreal colour shift, crisper. It grades colour and light; it
  does not move pixels, so architecture and composition are exactly where they were. If you ask for something it cannot
  do ("add a dragon"), it says so and suggests ComfyUI or a cloud method instead of pretending.
* ComfyUI edits are image-to-image with a denoise you control by the strength slider (lower keeps more).
* A cloud edit sends the picture and your instruction, only after you agree, and shows the price first.

## Conversational editing: levels, parts, references, alternatives, versions

The Edit tab and the companion share one editing system. Everything is non-destructive: the original is never opened for
writing, previews live in memory until kept, and every kept result is a new version linked to its source.

**Three levels** (Edit tab: *Subtle · Creative · Radical*; the companion chooses from your words):

| Level | What it is | For the AI model |
| --- | --- | --- |
| Subtle | Photographic polish; structure and detail stay | denoise about 0.24, tile ControlNet at full hold |
| Creative (default) | Changes the look and mood, keeps what matters | denoise about 0.52, hold 0.8 |
| Radical | A bold reinterpretation | denoise about 0.85, hold 0.35, selected parts are repainted from nothing |

The strength slider nudges within a level. Atlas Blend (no AI model) can only grade mood, light and colour; it says so when
asked for more.

**Only part of the picture.** *Only part of it* offers named parts (sky, background, foreground, top, bottom, left,
right, middle) and *Paint it myself* (brush, eraser, invert, soft edge). The selection is shown in red before anything is
made. The model repaints inside the mask (inpainting with ComfyUI's own `SetLatentNoiseMask` or `VAEEncodeForInpaint`),
then Atlas lays the result over the original **at the original's full size** through the soft mask, so every pixel outside
the selection and its soft edge is the original's own, byte for byte. This works with every method, including Atlas
Blend (mood in the sky only) and your own ComfyUI workflows. *The sky* is found from the picture's colours and where it
meets the top edge (region growing that follows gradients, fills clouds); it can be fooled by a smooth wall at the top, and
when it finds no clear sky it says so and asks you to paint.

**Reference looks.** *Use other pictures as a reference* takes single pictures or a whole moodboard. Their light, colour
and atmosphere are measured (Lab statistics, averaged over several pictures) and applied to the pixels *before* the model
works, in the amount you choose; the model then starts from that picture, and the look is also described to it in words.
So the result really follows the reference, measurably. **Not claimed:** composition and material cannot be taken from a
reference without an image-conditioned model (IP-Adapter, Flux Kontext); Atlas keeps this picture's composition and says so
in the result.

**Alternatives.** *Alternatives* makes up to four results with different seeds, shown side by side; keep the ones you like.

**Versions.** The history strip under the original lists every version of a picture, oldest first. Choosing any version
continues from it; editing an earlier version branches (siblings under one series). Nothing is ever replaced, so returning
to any earlier version is always possible. Pictures that were not made by Atlas start a series of their own.

**Detail that suits the picture.** The viewer's Atlas detail upscale has a *What is in it* choice: vegetation, architecture,
faces and people, texture and materials, or anything. Each changes the detail pass (faces are touched least, architecture
keeps straight lines, vegetation gets richer structure). By default Atlas guesses from the picture's history. Targets above
2048 px get the detail pass at 2048 px and then a second Real-ESRGAN enlargement to the final size.

### The companion as creative director

Sol, and any other compatible language model, reads what is installed (`studio_capabilities`) and then uses these tools:

* `propose_edit` opens the Edit tab filled in (level, part, reference) for you to review.
* `propose_edit_plan` prepares a multi-step process (alternatives, replace the sky, refine details, enlarge to 4K, a
  preset by name). You approve it once; Atlas then carries it out **on this computer with local tools only**, shows progress
  and puts the results in the conversation as pictures you can open at full size, compare and carry on from. Nothing is
  uploaded or paid for by a plan; cloud edits stay in the Edit tab, with the usual price and upload approval.
* `show_versions` lists every version with what each did, so you can go back or branch.
* `propose_external_edit` opens a copy in Photoshop (or another listed program); the saved result returns as a new linked
  version.

The built-in offline companion understands the same requests in plain wording ("try three artistic interpretations", "replace
the sky with something more mysterious", "the second one is best, improve its details and upscale it to 4K").

## Retouch: Remove, Heal, Blur, Sharpen, Dodge & Burn

The **Retouch** tab of the Creative Studio (also *Remove / blur…* in the picture viewer and in the large viewer) finishes a
picture without leaving Atlas. Five small tools share one way of working: paint over the part, see the result at once,
compare it with the original, undo or redo strokes, and keep it as a new version. The original file is never opened for
writing. Everything outside the painted area (and its soft edge) is the original, byte for byte, at the picture's own full size.

| Tool | What it does | How |
| --- | --- | --- |
| **Remove** | Takes out an object, stray detail or AI artifact and rebuilds the background. | *From the surroundings* (default): exemplar-based content-aware fill on this computer, no model. *AI (ComfyUI)*: inpainting with a checkpoint you already have, worked on the part around the mark at the model's resolution. *Cloud*: OpenAI image edit with a mask, only with your agreement to upload and pay. |
| **Heal** | Repairs a blemish, seam, damaged texture or local flaw so that it blends in. | Local. The colour and light come from the picture around the flaw (a normalised blur of the known pixels, so the flaw does not leak in); the fine texture is a mix of what is there and texture rebuilt from the surroundings (the slider). |
| **Blur** | Softens harsh transitions, artificial skin texture, oversharpened detail. | Local. Gaussian blur, or *Keep edges sharp*: a guided filter that smooths what lies between strong edges and keeps the edges. |
| **Sharpen** | Restores detail without halos or noise. | Local. Unsharp mask on brightness only (no colour fringes), with grain-sized detail left alone (coring) and the result limited to the local range (no halos). |
| **Dodge & Burn** | Lightens or darkens with a soft brush. | Local. A brightness curve that keeps black and white where they are, scaled colour channels so hue does not drift, and easing back instead of clipping. |

**Brush.** Size (`[` and `]`), softness of the edge, eraser (`E`), and a strength per tool. Scroll to zoom around the pointer
(up to 1600%), hold Space or use *Move* to pan. Strokes are kept as lines, not pixels, so **undo** (`Ctrl+Z`) and **redo**
(`Ctrl+Y`) are exact and the mask sent to the tools has the picture's own resolution (up to 3000 px on its long side).
Blur, Heal, Sharpen and Dodge & Burn follow the brush by themselves; Remove has a button, because a model can take a while.
Instead of painting, the quick tools can also take *a whole part* by name (sky, background, foreground, top, bottom, left,
right, middle).

**Finished edits.** An edit is one tool with its own marking, strength, softness and brush. It is *finished* when you switch to
another tool, press *Lock in this edit and continue*, or keep the picture. A finished edit is listed under *Finished edits*,
keeps its own settings, mask and result, and is **never recomputed**: the next edit starts from that result, so changing the
tool, the brush or any slider cannot change an edit that is already finished, and an edit in one place cannot change another place.
(Earlier, switching tool kept the old marking and applied the new tool to all of it; that was the cause of the
"Blur looked right, then Heal ruined it" report, see [STABILIZATION.md](STABILIZATION.md).) **Undo** (`Ctrl+Z`) first takes back
strokes of the edit you are working on, then finished edits one at a time; **Redo** brings them back exactly; *Discard all* returns
to the original and can also be redone. Up to 16 edits can be chained; *Keep as a new version* saves the picture as it is and you
carry on from the saved version.

**Remove is one removal at a time.** After a removal you can *Start a new removal* (the finished one is kept and the next starts with a clean
marking) or *Retry this area* (the same marking again, replacing this try). Painting again after a removal also starts a new removal, so a
new removal can never reuse the old marking, and the eraser only ever works on the marking of the removal in progress, never on a repair
that is finished. With ComfyUI, *Start from Atlas's own rebuild* (on by default) lets the model refine the local result instead of painting
the area from nothing.

**Strength.** Every strength has a number box (0.5-100 %). Blur also has a fine slider for 0.5-20 %, because a few percent is
usually enough and above about 10 % the softening is strong.

**Full screen.** *Full screen* (or `F`) gives the picture the whole window (and the real full screen, `Esc` to leave). Zoom, pan,
brush, marking and the before/after position stay exactly as they were; *Hide controls* gives the picture even more room.

**Compare.** A before/after slider, *Hold: original* (or `\`), and a switch for the red marking. **History.** *Keep as a new
version* saves the result as a linked version and carries on from it; the history strip lists every version, so any earlier
one can be returned to or branched from. Nothing is saved until you keep it.

**The companion.** Sol, and any compatible model, uses `propose_retouch` (one tool, one picture) and the `remove`, `heal`,
`blur`, `sharpen` and `tone` steps of `propose_edit_plan`. A part is named only when it can be found reliably (the sky, the
background, a side); for a face, hand, hair, object or blemish the Retouch tab opens with nothing marked and the companion
says the user has to paint it, instead of guessing. Plans of retouching steps run locally after one approval and nothing is
uploaded or paid for. The offline companion reads requests such as "remove the strange artifact near the hand", "soften the
overly sharp edges of the hair, but preserve the eyes", "heal the damaged texture on the cheek", "gently sharpen the
architectural details" and "brighten the face slightly and darken the background" (here the background is planned and the
face is handed to you to paint).

**How well it repairs.** On woven cloth with fine threads, Remove and Heal copy real threads from beside the flaw instead of
averaging them (averaging made a blurry round patch), the repaired area is blended from outside its edge (so a small mark is
replaced completely, not 90 %), and Heal always rebuilds the flaw's own outlier pixels whatever the texture slider says. Measured on
a synthetic cloth (`tests/retouchQuality.test.ts`, crops in `.e2e/retouch-quality`) and on real photographs. This is a good local
repair, not Photoshop-level reconstruction: unique detail still cannot be invented.

**Honest limits.** The local fill continues textures and structures from around the area, which works well on spots, wires,
small objects and repeating patterns; on chaotic texture or large areas it can look soft, and a face or other unique detail
cannot be invented without a model (use ComfyUI inpainting for those). Heal and Remove need known picture around the mark. Sharpen
cannot recover detail that is not in the picture. The sky and other named parts are found from colour and geometry, not from
understanding.

## Edit in another program

*Edit in Photoshop / PhotoCraft / my default program* (Edit tab). Atlas copies the picture to a working folder and opens the
**copy** in the program, so the original is never opened for writing. The session belongs to Atlas, not to the Studio
window: you can close the window, and a small chip (*Waiting for you to save in Photoshop*) stays visible.

**What counts as a result.** Atlas watches the copy and the files the program saves beside it with the same name and any
picture type, because programs differ: Photoshop overwrites a PNG or JPEG, but *Save As* often writes a PSD or TIFF next to
it. A file is read only after it has stayed unchanged for a moment and decodes completely (a file that is still being
written is waited for, never imported half-way). A save is **not** imported when it is pixel-identical to the original
("Saved without changes") or to a version already brought back ("no new version was made"), so repeated or unchanged saves
do not create duplicates. Every distinct save becomes the next linked version, chained to the one before, so the order of
saves is kept; the version's note records the editing session and file.

**Success is only reported when it is true.** The status goes *Saving your edit…* and then *Saved in Photoshop and added to
your library as a new version* only after the copy Atlas made of the result is saved, readable and in the library. If it is
not (for example the library has not picked it up), the panel says so and offers *Import it now*; nothing is reported as
done.

**Seeing the result.** When a save comes back, a window opens at once (and the taskbar button flashes with a notice if Atlas
is in the background): the original and the edited picture side by side with **locked zoom and pan** (scroll to zoom,
drag to move, `1:1` for real pixels, or a slider to wipe between them), the confirmation, and the next steps: *View edited
version*, *Compare before/after* (the large viewer, already comparing with the original), *Edit…*, *Retouch…*, *Enlarge…*,
*Add to moodboard*, *Edit again in Photoshop*. Several saves in one session are listed as tabs.

**Photoshop documents.** A PSD (or PSB) is imported as its **flattened picture**: every Photoshop file carries a composite of
its layers, 8 or 16 bit RGB or grey, and Atlas reads that. The layers stay in your own file; the version says so. CMYK,
Lab and 32-bit documents, and files saved without a composite, are refused with the way forward (*Export As… PNG*).

**Saved somewhere else.** *Saved it somewhere else? Find my saved file…* lists pictures changed since you opened it in your
Desktop, Downloads, Documents and Pictures folders (also in OneDrive), next to the original and one folder below it, with
names that resemble yours first; or *Choose a file…*. The file is copied, never moved or changed.

Atlas looks for Photoshop and PhotoCraft in the usual places; add any other program in the Studio settings. Only programs
you list there can be started. A session is watched for up to eight hours or until you choose *Stop watching*; sessions do
not survive closing Atlas (the versions already brought back do).

## Using reference pictures for real (FLUX.2 [klein])

On a moodboard each picture can be given what it is *for*: **atmosphere, composition, colours, materials or subject**,
and how strongly (loosely, balanced, closely). In “The pictures themselves” mode a local FLUX.2 [klein] model is given
the pictures, but each one prepared for its purpose, because handing over a picture unchanged makes the first one
dominate and leak its colours and style:

* composition → a grayscale layout sketch (arrangement without colour or texture),
* atmosphere and colours → a blurred study of light and colour (nothing to copy),
* materials → a close-up swatch of the most textured part,
* subject → the picture itself.

The instruction names each image by what it is (“the grayscale layout sketch (image 1)”). Up to four pictures are used
and share a memory budget so an 8 GB card copes. “Only their description” never sends picture data anywhere; “Automatic”
uses the pictures when a local model can and their description otherwise, and never uploads. A paid cloud method
(OpenAI multi-image editing) receives the pictures only when you choose “The pictures themselves”, agree to the upload
and approve the price. In Edit, “Give the model the reference pictures themselves” does the same for an edit (the picture
being edited is image 1).

Honest limits: composition and material transfer are partial, the identity of a particular person is weak, and results
vary with the model. The Studio shows these per model (“What each model can do with references”). FLUX.2 [klein] 4B is
available in the AI Model Library; its licence is Apache-2.0 (the 9B model is non-commercial).

## Changing moodboards in conversation

The companion can propose removing, replacing and rearranging pictures on an existing board ("Remove the redundant
duplicates from my "Quiet Valleys" moodboard", "Tidy my "Quiet Valleys" moodboard", or, with a language model connected,
"replace the three weakest pictures with better ones"). The proposal shows what leaves the board and what joins it.
Nothing changes until you press **Apply the change**.

Every change (by Atlas, or the board's own **Tidy** button) first stores a snapshot of the board's contents and layout.
**Undo** on the moodboard page restores exactly that, positions and sizes included. The pictures themselves are never
deleted from the library or from disk by any of this. Offline, Atlas finds near-identical pictures by comparing what the
image model sees; a language model can choose by meaning.

## Finding pictures on the whole computer

*Sources → Find pictures on this computer.* Choose drives, see the folders that are always left out (Windows, Program
Files, AppData, caches, temporary folders, `node_modules`, recycle bins, game and tool folders; any folder that holds a
program, recognisable by its libraries and package files; pictures smaller than icons), add folders of your own to leave
out, and search. The search is **read-only**: it lists folder and file names and sizes, and opens a handful of pictures
only to make small previews in memory.

You then see collections with sample previews, picture counts and sizes, with folders that sit side by side (a year of
trips) offered as one collection. Nothing is ticked for you. Only collections you tick are added to Atlas, with the same
indexing as any source. Drive roots themselves are never added.

## What is verified, and what is not

*Developer note: some of the scripts named below need private test pictures or a particular local ComfyUI installation and are not included in the public source.*

Verified by automated tests and by the real packaged application on Windows (see `scripts/e2e-studio.mjs`):

* The moodboard's zoom controls no longer collide with the companion.
* Moodboard to artwork with **Atlas Blend**: real pictures are made from real artworks, saved in the library, linked to
  the board and sources, with variations forming a series. The result differs from every reference. Originals unchanged
  (hash-checked).
* Conversational edit with preview, keep and discard; the original is untouched.
* Edit in another program with a real external process (a small launcher stands in for Photoshop): a copy goes out, the
  saved result is imported and linked.
* Proposals to tidy and prune a board, with before/after and a working undo; artwork concepts from the companion.
* Whole-drive discovery on a prepared folder tree: system folders, programs, caches and icons are skipped, collections
  are previewed before anything is indexed, nothing changes on disk.
* Cloud consent and price gating in the interface; request shape, price checks, monthly limit and key storage in unit
  tests. **The cloud service itself was never called.**
* The ComfyUI client, workflow construction, upload, polling and image retrieval against a **protocol stand-in** that
  speaks ComfyUI's HTTP API.
* ComfyUI setup (`scripts/e2e-comfy.mjs`): a fake portable installation and a stand-in server that makes real pictures:
  choosing the folder, identification, models and workflows, automatic start, connecting to an instance that is already
  running instead of starting another, closing only what Atlas started, running the user's editor-format and API-format
  workflows (and an upscaling workflow that doubles a picture's size), start-up failures, missing models, and a check
  that no file in the installation folder changed. The real ComfyUI Desktop installation on the test computer was
  recognised, read-only, and not started.

**Not verified: real AI image generation.** The machine this was built on has ComfyUI installed but no usable checkpoint
model, so no picture was painted by a diffusion model, and no cloud image service was contacted. Atlas Blend produces
real pixels but is not an AI model. Treat the ComfyUI and OpenAI methods as implemented and protocol-tested, not as
proven on real models, until you have tried them. If ComfyUI's node names differ in a future version, the standard graph
may need a small change; your own workflow file is the escape hatch.

### Viewer, Upscale and Compare (verified in the packaged app)

`scripts/e2e-upscale.mjs` (56 checks) runs the real packaged application: a generated picture opens at full resolution; 100%
is exactly one screen pixel per picture pixel; wheel, drag, double-click and keys behave; a plain 2x enlargement is saved
as a linked version with the original byte-for-byte unchanged; side by side, zoom and drag in either pane move both to
the same spot (positions read back from the page). It then runs a **real Clarity preset** ("cabin realistic" from the
portable ComfyUI project) through the real ComfyUI on a 512 px copy at 1024 px (about 70 to 90 seconds on this machine):
the sampler's seed, denoise and steps are exactly the preset's, only the scale step differs (0.6 to 0.5), the ComfyUI
installation and the presets are identical before and after, and the comparison shows visibly more distinct wood and grass
detail than the original. Not tested: large pictures (the same preset takes about 20 minutes on a 2944 px source), other
presets, and graphs without an upscale-model step followed by a scale step.

## Known limits

* Real-world check (`scripts/e2e-comfy-real.mjs`, needs a local portable ComfyUI project): the packaged app chose
  `runtime\ComfyUI`, used `runtime\venv`, port 8189 and the script's options, started it, ran the `cabin realistic` Clarity
  preset on a copy of a picture, connected to a copy the user started instead of starting another, stopped only its own,
  and confirmed the installation and presets were unchanged (ComfyUI wrote to a scratch folder).

* ComfyUI setup was tested against a stand-in server, not a real ComfyUI with real models: starting the real Desktop
  app, converting every kind of workflow and the real node definitions are **not verified**. Workflows that use ComfyUI's
  newer grouped nodes (subgraphs) cannot be opened directly; export them with *Export (API)*. Workflows that need custom
  nodes work only when those nodes are installed in your ComfyUI. Atlas cannot tell in advance whether a workflow's
  description input is bound to the right text box when a graph has several; it uses the one feeding the sampler.

* Atlas Blend cannot invent subjects; it re-uses what the references already contain.
* Reference pictures do not condition the AI methods directly (that needs custom ComfyUI nodes such as IP-Adapter); the
  references shape the prompt and, for variations, the starting picture. Use your own workflow file for IP-Adapter graphs.
* One picture per cloud request for `dall-e-3`; sizes are mapped to the closest size the service offers.
* "Edit in…" watches the working copy by modification time. Programs that save through a temporary file and rename work;
  programs that never save to the opened file do not.
* The Studio folder is `Pictures\NOEMA Atlas Studio`; it is added as a source the first time a picture is made.
* Discovery uses a rule-based filter. A photo folder inside a folder with program files would be skipped; use "search
  anyway" for a built-in name, or add the folder as a source by hand.
