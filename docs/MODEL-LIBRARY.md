# AI Model Library

The library is a searchable, hardware-aware catalogue of optional AI models. Open it from the Studio settings
(“Browse the AI Model Library…”) or let the Companion open it on a model it suggests. Nothing is downloaded until you
agree in the library; Atlas never runs third-party installers and never changes a ComfyUI that is not its own.

## What it shows

For this computer: graphics card, how much memory a model can really use (dedicated video memory, or for computers
with shared or unified memory a share of system memory), architecture (x64 or Arm64, and whether Atlas runs
emulated), and notes about the AI runtime on that hardware. Each model shows:

* what it does, and how well (good / partial / weak per ability),
* **fit** for this computer: recommended, works, works slowly, too large, not compatible, and why,
* **verification**: *Tested and verified* (Atlas ran it, with the hardware, date and result listed), *Documented, not
  tested* (the makers' documentation only), or *Experimental*,
* official source, version, licence (and whether commercial use is allowed), download size, requirements,
  dependencies and the workflows it works with,
* how it is installed here and its state: installed by Atlas, present in your own ComfyUI (found, never modified),
  partly downloaded, not installed.

Verification is only ever set from a real test. A **preview of another computer** (RTX 5080, RTX 5090, RTX Spark on
Windows on Arm, AMD, no graphics card) changes the recommendations shown, never what is installed, and is never
presented as a test.

## How models are installed

| Situation | What Atlas does |
|---|---|
| Atlas manages its own ComfyUI (Studio settings → AI setup) | Downloads the files into Atlas’s own folder after you agree: dependencies first, every file checked against its SHA-256, resumable, can be stopped, free space checked first. Removal deletes only files Atlas installed and keeps files another installed model still uses. |
| You use your own ComfyUI (a folder, or a server on the network) | Atlas only **reads** it to see which models exist. For anything missing it shows the official steps with your folders and checksums filled in. Press “Check my ComfyUI” after adding files. |
| Windows on Arm | No automatic ComfyUI install: there is no official portable build and x64 Python/CUDA packages cannot be assumed to work. Atlas shows the official instructions and notes. An external or network ComfyUI works as usual. |
| Local vision models (Ollama) | Atlas never installs Ollama. If your own Ollama is running, Atlas can ask it to pull a model after you agree (its own checksums apply); removal is done with `ollama rm`. |
| Models that need a login or licence acceptance | Manual steps only, with the reason. |

## Adding or changing entries without changing the app

Put `.json` files into the `model-library` folder inside Atlas’s data folder (`%APPDATA%\NOEMA Atlas\model-library`).
Each file is one entry, or an array of entries. An entry with the id of a built-in one replaces it. Files that are
invalid are ignored and the reasons are shown in the library. Downloads in user definitions must use `https://`.
The built-in catalogue is in `src/main/modelLibrary/catalog/*.json`; the format is `CatalogEntry` in
`src/shared/modelLibrary.ts`:

```json
{
  "schema": 1,
  "id": "my-model",
  "name": "My model",
  "summary": "One line.",
  "details": "A paragraph.",
  "categories": ["generation", "photoreal"],
  "capabilities": [{ "id": "photo", "label": "Photographic images", "level": "good" }],
  "version": "1.0",
  "runtime": "comfyui",
  "source": { "name": "Publisher", "url": "https://…" },
  "licence": { "name": "Apache-2.0", "url": "https://…", "summary": "…", "commercialUse": "yes" },
  "files": [{ "key": "my-model", "name": "my_model.safetensors", "folder": "checkpoints", "url": "https://…", "bytes": 1234567, "sha256": "64 hex characters" }],
  "requirements": { "minMemoryGB": 6, "recommendedMemoryGB": 8, "archs": ["x64"], "os": ["win32"] },
  "dependsOn": [],
  "workflows": [],
  "provides": ["create"],
  "verification": { "status": "documented", "checks": [] },
  "install": { "mode": "managed" }
}
```

Categories: `generation`, `photoreal`, `artistic`, `editing`, `reference`, `upscaling`, `understanding`.
`install.mode` is `managed`, `manual`, `ollama` or `atlas`. Variants (for example a smaller build for Blackwell
cards) are listed under `variants` with their own files and requirements.

## What was tested here

* **Real hardware (RTX 2080, 8 GB, Windows 11 x64):** hardware detection; reading the existing ComfyUI’s models
  without writing to it (identical afterwards); a real download of Real-ESRGAN from its official source with checksum
  verification and clean removal in a scratch folder (`tests/modelLibraryReal.test.ts`, run with
  `NOEMA_REAL_HW=1`); FLUX.2 [klein] 4B generating from four reference pictures (`scripts/e2e-reference.mjs`).
* **Unit-tested with simulated hardware:** RTX 2080/3060/4090/5080/5090, an old driver on Blackwell, RTX Spark on Arm64
  (unified memory, native and emulated), AMD and no-GPU computers; downloads from a local server (consent, dependency
  order, checksum failure, resume, shared-file-safe removal, tampering detection, low disk space, connect-mode
  read-only behaviour, Ollama pulls, user catalogue).
* **Not tested on real hardware:** RTX 50-series, RTX Spark / Windows on Arm, AMD and Intel graphics, any Ollama model
  download, installing a full model through the library UI end to end on a managed ComfyUI (only the 67 MB model).
