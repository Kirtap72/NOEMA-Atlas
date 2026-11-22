// A small hand-over point so the Companion's tools can read the AI Model Library without the assistant being wired to it
// (the library is created in the Studio's registration, the assistant in its own).
import type { ModelLibrary } from './library'

let current: ModelLibrary | null = null
export function setModelLibrary(library: ModelLibrary | null): void {
  current = library
}
export function modelLibrary(): ModelLibrary | null {
  return current
}

/** Opens the library window (the real, interactive catalogue) from anywhere in the main process, for example when the Companion is asked to. */
export interface OpenLibraryRequest {
  entry?: string
  search?: string
  category?: string
}
let opener: ((request: OpenLibraryRequest) => void) | null = null
export function setLibraryOpener(fn: ((request: OpenLibraryRequest) => void) | null): void {
  opener = fn
}
export function openLibraryUi(request: OpenLibraryRequest): boolean {
  if (!opener) return false
  opener(request)
  return true
}
