import { describe, expect, it } from 'vitest'
import { cleanPrompt, parseChat, parseInline, promptInLine, promptsIn } from '../src/renderer/src/lib/chatMarkdown'

describe('headings and structure', () => {
  it('turns ### into a heading instead of showing the characters', () => {
    const parts = parseChat('### Three directions\n\nSome words\n\n## Next\n#### Small')
    expect(parts[0]).toEqual({ kind: 'heading', level: 3, text: 'Three directions' })
    expect(parts.some((p) => p.kind === 'heading' && p.level === 2 && p.text === 'Next')).toBe(true)
    expect(parts.some((p) => p.kind === 'heading' && p.level === 4)).toBe(true)
    expect(JSON.stringify(parts)).not.toContain('###')
  })

  it('reads bullet and numbered lists separately, rules and quotes', () => {
    const parts = parseChat('- one\n- two\n\n1. first\n2) second\n\n---\n\n> a quote\n> goes on')
    expect(parts[0]).toEqual({ kind: 'list', ordered: false, start: 1, items: ['one', 'two'] })
    expect(parts[1]).toEqual({ kind: 'list', ordered: true, start: 1, items: ['first', 'second'] })
    expect(parts[2]).toEqual({ kind: 'rule' })
    expect(parts[3]).toEqual({ kind: 'quote', text: 'a quote\ngoes on' })
  })

  it('keeps code blocks whole and does not treat their lines as markdown', () => {
    const parts = parseChat('```\n# not a heading\n- not a list\n```')
    expect(parts).toEqual([{ kind: 'code', text: '# not a heading\n- not a list', lang: '' }])
  })

  it('formats bold, italic and code, and shows links as plain text', () => {
    expect(parseInline('a **b** *c* `d` [e](https://x.y)').map((p) => p.kind + ':' + p.text)).toEqual([
      'text:a ', 'bold:b', 'text: ', 'italic:c', 'text: ', 'code:d', 'text: ', 'text:e (https://x.y)'
    ])
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }])
  })
})

describe('finding image prompts', () => {
  it('copies only the words of a labelled prompt', () => {
    expect(promptInLine('**Prompt 1:** A lighthouse at dusk, oil painting, --ar 3:2')).toEqual({ text: 'A lighthouse at dusk, oil painting, --ar 3:2', label: 'Prompt 1' })
    expect(promptInLine('1. Prompt: "A quiet harbour in fog"')?.text).toBe('A quiet harbour in fog')
    expect(promptInLine('- **Image prompt**: `misty pines, soft light`')?.text).toBe('misty pines, soft light')
    expect(promptInLine('Prompt - a red fox in snow')?.text).toBe('a red fox in snow')
    expect(promptInLine('I would write a prompt for you later')).toBeNull()
    expect(promptInLine('Prompts are tricky')).toBeNull()
  })

  it('recognises lines with generator flags', () => {
    expect(promptInLine('1. a tall ship in a storm, dramatic light --ar 16:9 --v 6')?.text).toBe('a tall ship in a storm, dramatic light --ar 16:9 --v 6')
    expect(promptInLine('Use --ar 16:9')).toBeNull()
  })

  it('finds every prompt in a long answer with several prompts, blocks and quotes', () => {
    const answer = [
      '## Three ideas for your harbour series',
      '',
      'Here is the first direction, built from your favourite foggy pictures.',
      '',
      '**Prompt 1:** A lone fishing boat in fog, muted teal and grey, soft diffused light',
      '',
      '### Second direction',
      'Prompt 2:',
      '```',
      'Wet cobbled quay at dawn,',
      'long reflections, film grain',
      '```',
      '',
      '### Third: prompt',
      '> Lighthouse beam cutting through rain, painterly, high contrast',
      '',
      '- Not a prompt: just a note',
      '```prompt',
      'A final one in a labelled block',
      '```'
    ].join('\n')
    expect(promptsIn(answer)).toEqual([
      'A lone fishing boat in fog, muted teal and grey, soft diffused light',
      'Wet cobbled quay at dawn,\nlong reflections, film grain',
      'Lighthouse beam cutting through rain, painterly, high contrast',
      'A final one in a labelled block'
    ])
    const parts = parseChat(answer)
    expect(parts.filter((p) => p.kind === 'heading')).toHaveLength(3)
  })

  it('cleans list markers, quotes, backticks and bold from a prompt, and nothing else', () => {
    expect(cleanPrompt('  3.  **“sunlit meadow”**  ')).toBe('sunlit meadow')
    expect(cleanPrompt('`a b`')).toBe('a b')
    expect(cleanPrompt('keep "inner" quotes')).toBe('keep "inner" quotes')
  })

  it('does not choke on very long lines', () => {
    const long = 'word '.repeat(5000)
    const parts = parseChat(`**Prompt 1:** ${long}\n\n${long}`)
    expect(parts[0]!.kind).toBe('prompt')
    expect(parts[1]!.kind).toBe('paragraph')
  })
})

describe('tables', () => {
  it('turns a Markdown table into a real table, never raw pipes and dashes', () => {
    const parts = parseChat('Here are the models:\n\n| Model | Fit | State |\n|---|:---:|---|\n| FLUX.2 [klein] 4B | Works | **Installed** |\n| Real-ESRGAN | Works | Not installed |\n\nThat is all.')
    const table = parts.find((p) => p.kind === 'table')
    expect(table).toEqual({ kind: 'table', header: ['Model', 'Fit', 'State'], rows: [['FLUX.2 [klein] 4B', 'Works', '**Installed**'], ['Real-ESRGAN', 'Works', 'Not installed']] })
    expect(JSON.stringify(parts)).not.toContain('|---|')
    expect(parts[0]).toEqual({ kind: 'paragraph', text: 'Here are the models:' })
    expect(parts[parts.length - 1]).toEqual({ kind: 'paragraph', text: 'That is all.' })
  })

  it('accepts tables without outer pipes and rows with missing cells, and leaves lines with a pipe alone otherwise', () => {
    const parts = parseChat('a | b\n--- | ---\n1 | 2\n3')
    expect(parts[0]).toMatchObject({ kind: 'table', header: ['a', 'b'] })
    expect(parseChat('use a | b in the shell').every((p) => p.kind === 'paragraph')).toBe(true)
  })
})
