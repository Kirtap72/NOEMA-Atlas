/**
 * Curation: choosing a few images from many for a purpose, the way a thoughtful person would, from evidence.
 * Nothing here scores "quality". Each pick is explained by what Atlas measured (how well it fits the description,
 * how close it is to this user's own favorites and choices, how it sits with the other picks) and by what kind of
 * image it appears to be (a finished work, an experiment, or a technical working image such as a software screenshot).
 */

/** What an image appears to be. A technical image is not a bad image; it is rarely what a moodboard is for. */
export type CurationRole = 'finished' | 'experimental' | 'technical' | 'unclear'

export interface CuratedPick {
  imageId: string
  role: CurationRole
  /** Short reasons, each backed by something measured or by what the user did. */
  reasons: string[]
  /** How well the image fits the description (0 to 100), when there is one. */
  match: number | null
  /** True when the evidence for this pick is mixed and the user should look twice. */
  uncertain: boolean
}

export interface CuratedLeftOut {
  imageId: string
  why: 'technical' | 'duplicate' | 'weak' | 'passed'
  detail: string
  role: CurationRole
}

/** Everything the review panel needs; nothing is created until the user approves. */
export interface CuratedProposalData {
  kind: 'curated-moodboard'
  /** The suggested name of the new moodboard. */
  name: string
  /** Where the candidates came from, in words ("the smart collection “Moody landscapes”"). */
  source: string
  /** The images proposed, best first. Also what `imageIds` lists, so generic code keeps working. */
  imageIds: string[]
  picks: CuratedPick[]
  /** Next best choices the user can swap in, best first. */
  alternatives: CuratedPick[]
  /** Candidates that were considered and left out, with the reason. They can still be added by hand. */
  leftOut: CuratedLeftOut[]
  requested: number
  /** Why fewer than requested are proposed, when that is so. */
  shortfall: string | null
  /** How the user's own taste entered the choice, or why it could not. */
  tasteBasis: string
  /** How many images were looked at. */
  considered: number
  /** The user's current choice while reviewing (ids). Kept so a reload does not lose it. */
  selection?: string[]
}

export interface CompanionView {
  /** What the user is looking at in the window right now, so "this collection" means something. */
  kind: 'smart' | 'family' | 'moodboard' | null
  id?: string | null
  name?: string
  /** For a smart collection: its description and settings, including edits that are not saved yet. */
  criteria?: unknown
}
