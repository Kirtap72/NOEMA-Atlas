# ComfyUI as an optional part of Atlas (design)

Status: **design for the broader installer. Not built yet.** What exists today is the first mode, "connect an existing
installation", which is working and tested against a developer's existing ComfyUI installation (see `docs/STUDIO.md`). This
document says what the other two modes must do, so what is built now does not have to be redone.

## Principles

1. **Atlas works fully without ComfyUI.** The library, Families, Smart Collections, the Companion, moodboards, Atlas
   Blend and the optional cloud method never need it. Nothing in the first run asks for it or nags about it.
2. **An existing installation is never changed.** Atlas reads it, starts it the way its owner starts it, and stops only
   what Atlas itself started. Models and workflows are never moved, renamed, upgraded or "fixed".
3. **Nothing is downloaded or installed without a plain question first**, which says what it is, how large it is, where
   it goes, what licence it comes under and whether this computer can run it. The default answer is "no".
4. **Everything Atlas installs lives in one folder the user chose** (any drive), can be moved or removed by deleting that
   folder, and is never mixed into another ComfyUI.
5. **Every check is explainable.** If a model is not offered, the reason is shown in simple words ("needs about 12 GB
   of video memory; this computer has 8 GB").

## The three modes

The Studio settings show one choice, made once and changeable later:

| Mode | What Atlas does | What it needs |
|---|---|---|
| **Use my ComfyUI** (built) | Reads the chosen folder, finds Python, port, start options, models and workflows, starts or connects to it. | An existing installation. |
| **Install a separate ComfyUI for Atlas** (to build) | Creates a managed runtime in a folder the user picks (any drive), with its own Python environment and no shared state. | Free disk space, a supported graphics card, a download. |
| **Use Atlas without ComfyUI** (built) | Hides ComfyUI settings behind "Set up later". | Nothing. |

Switching mode never deletes anything the user owns. "Forget it" only removes Atlas's note about the folder.

### Mode 1: connect an existing installation (built)

Choose the folder once. Atlas recognises the portable download, the Desktop app and a source install, including a
project layout where the Python environment sits beside the ComfyUI folder (`runtime\ComfyUI` + `runtime\venv`). It reads
start scripts that sit next to the installation (never runs them) and offers their port and options, finds workflow
folders outside the installation (`presets\…`), and lets the user change the Python, port, start options and workflow
folders. If a port is chosen, Atlas talks only to that port, so another ComfyUI on the usual port is never borrowed by
mistake. A workflow that needs a custom node that is not installed is reported by node name before anything runs.

### Mode 2: a separate managed runtime (to build)

Layout, all inside the folder the user chose (`<chosen>\Atlas ComfyUI\`):

```
runtime\   ComfyUI at a pinned release, its own Python environment, pip cache
models\    only what the user approved, one sub-folder per kind (checkpoints, loras, controlnet, upscale_models…)
workflows\ approved workflow packs
state.json what is installed, versions, sizes, hashes, licences accepted (with date)
```

Steps, each one a confirmation the user can stop at:

1. **Hardware check** (read only, local): Windows version, free space on the target drive, system memory, graphics card
   name and video memory (`nvidia-smi` when present; otherwise "unknown", never guessed). Result in one sentence:
   "Your RTX 2080 has 8 GB: good for SD 1.5 and SDXL, too small for the largest models."
2. **Space and drive**: show the size of the runtime (the pinned ComfyUI plus a Python environment with PyTorch is
   several GB) and the free space left on that drive after it. Refuse to proceed under a safety margin (default 20 GB
   or 15 %, whichever is larger).
3. **Download the runtime** from the pinned, signed manifest (below), verifying every file's SHA-256 before use.
   Progress, pause and cancel. A cancelled or failed install leaves a folder that can be deleted, and nothing else.
4. **First start and self-check**: Atlas starts the runtime on a free port (kept in `state.json`), asks `/system_stats`
   and `/object_info`, and runs a tiny built-in graph that needs no downloaded model, to show it works.
5. **Updates are never automatic.** A newer pinned release is offered with its release notes; the old runtime is kept
   until the new one passes the self-check.

Atlas does not bundle ComfyUI. It downloads it at install time, as a separate program that Atlas talks to over HTTP on
`127.0.0.1`. ComfyUI is GPL-3.0 software; downloading and running it as its own program and showing its licence in the
install dialog keeps that boundary clean. Custom nodes are never installed automatically. A workflow pack that needs
them lists them by name, repository and commit, and installs them only after a separate approval each.

### Optional model packs and workflow packs

Models and workflows are **packs** described by a manifest, never hard-coded:

```jsonc
{
  "id": "sdxl-base-1.0",
  "title": "SDXL base",
  "kind": "checkpoint",            // checkpoint | lora | controlnet | upscale | vae | text-encoder | workflow-pack
  "files": [{ "name": "…safetensors", "url": "https://…", "sha256": "…", "bytes": 6938078334, "folder": "checkpoints" }],
  "license": { "name": "…", "url": "https://…", "commercialUse": "yes | no | conditions", "reviewedOn": "2026-11-18" },
  "requires": { "vramGb": 8, "diskGb": 7, "families": ["SDXL"] },
  "worksWith": ["upscale-tile-sdxl"],
  "source": "huggingface.co/…"      // shown to the user; the download goes straight from there
}
```

Rules for packs:

- **Licence first.** The licence name, link and the one-line "may I use this commercially?" answer are shown before the
  download button is enabled. Packs whose licence has not been reviewed are not listed. The project's own
  `evidence\clarity\LICENSE_REVIEW.md` is the model for what a review records. Atlas states what a licence *says*, and
  tells the user to read it; it does not give legal advice.
- **Size and hardware first.** The size is shown in GB with the free space after the download. A pack whose
  `requires.vramGb` is above the detected card is shown greyed with the reason, and can still be installed by someone
  who insists, with a warning, because the detection can be wrong.
- **Integrity.** Download to a temporary name, verify the SHA-256, then move into place. A mismatch is deleted and
  reported. Resumable downloads; nothing is overwritten.
- **Shared, not duplicated.** If the same file (by hash) already exists in a connected installation or another folder
  the user lists, Atlas offers to *point at it* (an extra model path) rather than download it again.
- **Workflow packs** are plain `workflow_api.json` files plus a manifest naming the models and nodes they need. Atlas
  shows which pieces are present, which are missing and their combined size, so "enable this workflow" is one honest
  question, not a surprise.
- **Nothing is installed because a workflow asks.** A workflow that references a missing model only produces an
  explanation, as now.

### Mode 3: no ComfyUI

The ComfyUI panel is replaced by one line, "Atlas Blend works without ComfyUI. You can set it up later", and the
Studio shows only the methods that are available. Prompt writing, concept development, moodboards and Atlas Blend work
exactly as before.

## What must be built, in order

1. **Done:** connect an existing installation, including project layouts, ports, Python, start scripts, workflow folders,
   custom-node check, real startup test (this change).
2. Hardware check module (`hardware.ts`): GPU name and memory, disk free, RAM; pure, read-only, unit-tested with fake
   command output. Used by every later step and shown on its own in the settings.
3. Pack manifest format, validator and the licence / size / hardware gate (no downloading yet), with a local file as the
   manifest source so it can be reviewed and tested.
4. Resumable, hash-verified downloader with free-space checks and cancel.
5. Managed runtime installer (pinned release, own environment) and its self-check; the settings chooser for the three
   modes.
6. Model and workflow packs for a small curated starter set, each with a reviewed licence.
7. Updating and removing a managed runtime ("Remove Atlas's ComfyUI" deletes only its own folder, after showing what
   will go and how much space it frees).

## Risks and open questions

- **Pinned manifest hosting and signing.** The manifest must come from somewhere Atlas controls and be signed, or an
  attacker who can change it can make Atlas download anything. Until that exists, step 3 uses a manifest shipped
  inside Atlas.
- **PyTorch and driver matching** is the most common failure of a fresh ComfyUI. The installer must pick a PyTorch build
  from the detected driver and show a plain error when it cannot.
- **Licences change.** `reviewedOn` is shown; packs older than a year are flagged for re-review.
- **Antivirus and long paths** on Windows can break an install in a deep folder; the chooser should warn about both and
  keep the default path short.
- **Disk quotas on external drives**: a drive that is removed while a model is in use must produce a clear status, not
  a hang.
