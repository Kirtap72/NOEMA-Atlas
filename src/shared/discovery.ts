// Types for finding pictures across whole drives, shared by the main process and the interface.

export interface DriveInfo {
  path: string
  label: string
  isSystem: boolean
}

export interface DiscoveryOptions {
  /** Drives or folders to search. */
  roots: string[]
  /** Folders the user does not want searched, in addition to the built-in list. */
  excludePaths: string[]
  /** Built-in excluded folder names the user chose to search anyway. */
  includeNames?: string[]
  /** Folders with fewer pictures than this are ignored. */
  minImages: number
}

export interface DiscoveryProgress {
  scannedFolders: number
  skippedFolders: number
  imagesFound: number
  collectionsFound: number
  /** The folder being looked at right now. */
  current: string
}

export interface DiscoveredCollection {
  path: string
  name: string
  images: number
  bytes: number
  /** How many folders were merged into this collection. */
  folders: number
  /** Paths of a few pictures that stand for the collection. Previews are made on demand and nothing is stored. */
  samples: string[]
  newest: number
  /** Already part of Atlas (or inside something that is). */
  inAtlas: boolean
}

export interface DiscoveryResult {
  collections: DiscoveredCollection[]
  scannedFolders: number
  skippedFolders: number
  cancelled: boolean
}
