import { describe, expect, it } from 'vitest'
import { parseRetouch } from '../src/main/assistant/basics'

describe('reading retouching requests', () => {
  it('takes a stray artifact near a hand as a Remove that the user has to mark', () => {
    const [c, ...rest] = parseRetouch('Remove the strange artifact near the hand.')
    expect(rest).toHaveLength(0)
    expect(c).toMatchObject({ tool: 'remove', region: undefined })
  })
  it('softens the hair edge-aware, and does not turn "preserve the eyes" into a step', () => {
    const list = parseRetouch('Soften the overly sharp edges of the hair, but preserve the eyes.')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ tool: 'blur', region: undefined, edgeAware: true })
  })
  it('heals texture on a cheek only after the user marks it', () => {
    expect(parseRetouch('Heal the damaged texture on the cheek.')[0]).toMatchObject({ tool: 'heal', region: undefined })
  })
  it('sharpens gently', () => {
    const c = parseRetouch('Gently sharpen the architectural details.')[0]!
    expect(c.tool).toBe('sharpen')
    expect(c.strength).toBeLessThan(0.35)
    expect(c.region).toBeUndefined()
  })
  it('splits two tone steps: the face needs marking, the background can be found', () => {
    const list = parseRetouch('Brighten the face slightly and darken the background.')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ tool: 'tone', tone: 'lighten', region: undefined })
    expect(list[1]).toMatchObject({ tool: 'tone', tone: 'darken', region: 'background' })
  })
  it('does not take "the person on the left" for the left side of the picture', () => {
    expect(parseRetouch('Remove the person on the left')[0]).toMatchObject({ tool: 'remove', region: undefined })
    expect(parseRetouch('Darken the left side')[0]).toMatchObject({ tool: 'tone', region: 'left' })
  })
  it('leaves other requests alone', () => {
    expect(parseRetouch('Replace the sky with something more mysterious')).toHaveLength(0)
    expect(parseRetouch('Try three artistic interpretations of the first one')).toHaveLength(0)
    expect(parseRetouch('The second variation is best. Improve its fine details and upscale it to 4K')).toHaveLength(0)
  })
})
