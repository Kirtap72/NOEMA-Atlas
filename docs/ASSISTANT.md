# The Atlas companion: architecture

Atlas has a small conversational companion, also called Atlas, that works on top of the systems the application already has: visual search, families, favorites and the reference collection, taste, discovery journeys and moodboards. It adds no new copy of the user's data; it reads through tools and proposes changes that the user accepts.

## Three layers

1. **Providers** (`src/main/assistant/providers.ts`): a model-independent `ChatProvider` interface (`complete`, `listModels`). Two wire formats cover almost everything, with plain `fetch` and no vendor SDK:
   - OpenAI chat format: OpenAI, OpenRouter, **Ollama**, **LM Studio**, llama.cpp server, vLLM and any compatible company server.
   - Anthropic Messages format.
   Ollama and LM Studio are detected on `127.0.0.1` (ports 11434 and 1234) only when the user opens the settings.
2. **Tools** (`tools.ts`): `library_overview`, `search_images`, `describe_images`, `favorites_profile`, `taste_summary`, `list_families`, `family_images`, `list_moodboards`, `moodboard_contents`, `suggest_for_moodboard`, `reference_matches`, `journey_ideas`, `propose_moodboard`, `propose_add_to_moodboard`. They call the same engines as the rest of the application (SemanticSearch, IdentityEngine, TasteEngine, JourneyEngine, the reference collection, the database).
3. **Engine** (`engine.ts`): conversations (JSON files in `<userData>/assistant/chats`), the tool loop (at most six rounds), reading `[library]` / `[idea]` markers, and applying proposals.

**Atlas basics** (`basics.ts`) is the assistant without any language model: a small rule-based router that uses the same tools for the requests listed in the welcome screen (find images, what favorites share, artists to discover, moodboard help, creative directions, prompts from images). It makes the companion useful and fully offline when nothing is configured.

## OpenAI Responses API and verification

OpenAI's newer models (GPT-5 and GPT-6 families such as gpt-6.1-sol, and the o-series) do not accept function tools with reasoning on `/v1/chat/completions`. `OpenAiResponsesProvider` speaks `/v1/responses` with the same tools and history: flat function tools, `function_call` / `function_call_output` items tied by call id, `store: false` (nothing kept at the provider) and encrypted reasoning items carried between the steps of one answer. No `reasoning_effort` is ever sent. `OpenAiAdaptiveProvider` picks the format by model name for api.openai.com and, for any other address or unknown model, learns from the provider's own "not supported in /v1/chat/completions" error, falls back once and remembers. Older models (gpt-4o and so on), Ollama, LM Studio and others stay on Chat Completions.

The connection test checks three things separately: the server is reachable (model list), the chosen model answers a real request, and it calls a tool and uses the tool result. Only then is the setup "verified", the header shows `Provider · model`, and Atlas greets once (with the model's own words). Changing provider, model, address or key voids the verification. The test request is fixed text with no library data.

## Understanding what the user means

`intent.ts` reads a request with weighted cues instead of exact phrases, in English and Swedish. A question about the person ("What is my personal taste?", "Vad är min smak?", "What am I drawn to?", "Beskriv min stil") is answered from the Artistic Identity engine (favorites) and the Taste Compass (choices), and is never an image search. A request that clearly asks for pictures ("find foggy forests", "hitta bilder på ...") still searches. When both are present ("find images that match my taste") or a question about the user has no recognisable subject, Atlas asks one short question instead of guessing. With a language model the same rule is in the system prompt. Covered by `tests/assistant.test.ts` and section C2 of `scripts/e2e-assistant.mjs`.

## Honest answers

- Every paragraph an answer produces is marked as **From your library** (supported by tool results) or **An idea of mine** (suggestion, speculation, general art knowledge). The system prompt requires the markers; the interface draws them differently (solid gold rule versus dashed sage rule).
- Reference-collection matches are described as visual resemblance, never influence; the collection is said to be thin on abstraction and contemporary art.
- Tentative evidence (few favorites, tentative groups, visual search off) is stated.

## Changes stay with the user

The assistant cannot write. `propose_moodboard` and `propose_add_to_moodboard` only create a *proposal card* in the conversation (`pending`). The database is touched only by `AssistantEngine.respondToProposal(..., accept = true)`, which runs when the user presses **Accept**. Nothing in the assistant moves, renames, rates or deletes images or files.

## Privacy and credentials

- The model never receives image files, thumbnails, image ids or full paths. Images are referred to by short per-conversation references (`i1`, `i2` ...). It receives descriptions: tags, dominant colour, rating, favorite flag, family and moodboard names, everyday-language terms from the local image model ("misty", "painterly", "forest" ...), taste qualities.
- Providers that leave the computer need an explicit consent, per provider, that lists what is sent and what is not. A second, separate consent allows file and folder *names*. Without consent no request is made, including the connection test. Switching to another cloud provider asks again.
- Addresses on the user's own computer (`localhost`, `127.0.0.1`, `::1`) are treated as local: no consent is needed and names may be included.
- API keys are encrypted with the operating system's key store (Electron `safeStorage`, Windows DPAPI), written only to `<userData>/assistant/keys.json`, and never sent to the interface (it only learns `hasKey`). When the system cannot store secrets the key is held in memory until Atlas closes. Error messages never contain the key.

## Offline

With no provider configured (the default) nothing is contacted. The companion, the reference collection, search and all other rooms work without a network.

## Tests

- `tests/assistant.test.ts`: provider request/response mapping for both formats, error handling without key leaks, encrypted key storage, per-provider consent, answer parsing, the basics, proposals that change nothing until accepted, tool use through a scripted model, privacy of what is sent.
- `scripts/e2e-assistant.mjs`: the real application with the real image model, a library made of reference artworks, a mock language model on `127.0.0.1`, consent, key storage, restart persistence and unchanged originals. Run it against the packaged app with `--exe "release/win-unpacked/NOEMA Atlas.exe"`.

## Planned: automatic discovery across drives (not built yet)

The companion comes first. The plan for finding images across selected drives or the whole computer:

1. **Opt-in, explicit scope.** A "Find images on this computer" assistant step lets the user tick drives or folders. Nothing is scanned before that, and the choice is stored per source like any other source folder.
2. **Exclusions by default**: `Windows`, `Program Files*`, `ProgramData`, `$Recycle.Bin`, `System Volume Information`, `AppData` caches, `node_modules`, `.git`, browser caches, `Thumbs.db`/`.thumbnails`, game and engine asset folders; images under 64×64 px or under 8 KB (icons, UI sprites), and files inside application folders (detected by a nearby `.exe`/`.dll` density).
3. **Candidates, not imports.** A read-only pass produces a candidate list grouped by folder, with counts and previews. The user chooses folders to add as ordinary sources; originals are never moved or altered, exactly as today.
4. **Cheap first**: enumerate with the existing scanner in "dry run" mode (no thumbnails, no hashing), use file size, dimensions and folder name heuristics to rank, and let the local image model flag screenshots and technical images with the same guard the Taste Compass already uses.
5. **Assistant integration**: a `find_candidate_folders` tool and a proposal card ("Add these 4 folders as sources?") using the same accept-to-apply mechanism.
