# Third-party notices

NOEMA Atlas application code, Copyright © 2026 Patrick Karlsson, is released under the MIT licence (`LICENSE`); NOEMA is the project and product name. The Windows download and this source tree also include or depend on the
following components, each under its own terms. This file is a guide, not a replacement for the original notices, which are kept in `build/third-party/`
(and ship inside the Windows download in `resources/third-party/`) and in each package's own licence files.

| Component | Used for | Licence | Where the notice is |
|---|---|---|---|
| Electron 45 and Chromium | the application shell | MIT (Electron); Chromium components under their own licences | `LICENSE.electron.txt` and `LICENSES.chromium.html` inside the Windows download |
| React, React DOM | interface | MIT | each package's `LICENSE` |
| sharp 0.35 and libvips 8.18 (`@img/sharp-win32-x64`) | preview and image processing | sharp: Apache-2.0; libvips shared libraries: LGPL-3.0-or-later with component notices | `build/third-party/sharp-libvips-NOTICES.md`, `LGPL-3.0.txt`, `GPL-3.0.txt`, `sharp-win32-versions.json` |
| ONNX Runtime 1.31 (`onnxruntime-node`) | optional local image model | MIT | `build/third-party/ONNX-Runtime-LICENSE`, `ONNX-Runtime-ThirdPartyNotices.txt` |
| DirectML 1.15 and DirectX Shader Compiler | optional GPU acceleration for the image model | Microsoft licence terms | `build/third-party/DirectML-*.txt`, `DXC-*.txt` |
| `@huggingface/tokenizers` | text handling for the image model | Apache-2.0 | package licence |
| umap-js | map of the reference collection | MIT | package licence |
| Fraunces and Manrope (`@fontsource-variable/*`) | typefaces | SIL Open Font License 1.1 | package licences |
| SigLIP base patch16 224 (downloaded by the user, not bundled) | optional image model | Apache-2.0 (see the model page on Hugging Face) | https://huggingface.co/Xenova/siglip-base-patch16-224 |

## Source for the LGPL libraries

The Windows build uses libvips and its dependencies as separate, dynamically loaded libraries. Their upstream source and build scripts:

- https://github.com/lovell/sharp/tree/v0.35.5
- https://github.com/libvips/libvips/tree/v8.18.7
- https://github.com/lovell/sharp-libvips/tree/v1.3.4 (pinned versions: `versions.properties`)

## The Atlas Reference Collection

`reference/` holds 1,162 artwork images (web copies of at most 800 px), their data and precomputed vectors. All works were published by their museums as
public domain / CC0 when retrieved (2026-11-16): 696 from the **Cleveland Museum of Art** (https://www.clevelandart.org/open-access) and 466 from the
**Art Institute of Chicago** (https://www.artic.edu/open-access). Each entry keeps its title, maker, date, credit line and museum object link in
`reference/manifest.json`; see `reference/CREDITS.md`. CC0 does not require credit; the museums are credited as a courtesy. Atlas is not affiliated with them.
A museum may later change its own statement for a work; the linked object page is authoritative.

## Trademarks

Names such as Electron, Chromium, Microsoft, Windows, DirectML, Hugging Face, Cleveland Museum of Art, Art Institute of Chicago, Photoshop, GIMP,
ComfyUI, OpenAI, Anthropic and Claude belong to their owners and are used only to say what Atlas can work with.
