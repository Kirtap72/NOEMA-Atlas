/**
 * The aesthetic dimensions shown on the Taste Compass. Each axis has two opposite poles, described by a few short
 * phrases. The phrases are only used to measure how strongly each library image shows that quality (by comparing
 * the image's embedding with the phrase's embedding); what the user prefers is always taken from their own choices.
 */
export interface DimensionSpec {
  id: string
  axis: string
  axisLabel: string
  pole: 'a' | 'b'
  label: string
  /** Plain-language description shown to the user. */
  description: string
  prompts: string[]
}

import dimensions from '../shared/dimensions.json'

export const TASTE_DIMENSIONS: DimensionSpec[] = dimensions as DimensionSpec[]
