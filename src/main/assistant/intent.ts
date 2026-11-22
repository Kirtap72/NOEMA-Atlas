/**
 * Intent recognition for "Atlas basics" (no language model). It tells apart a question ABOUT THE USER ("What is my
 * personal taste?", "Vad är min smak?") from a request to FIND IMAGES, using weighted cues in English and Swedish
 * rather than exact phrases. When the evidence is genuinely mixed it says so, and the companion asks instead of guessing.
 */
export type TasteIntent = 'taste' | 'search' | 'ambiguous' | 'other'

export interface IntentReading {
  intent: TasteIntent
  taste: number
  search: number
}

/** Lower-case and strip quotes. Accents are kept: å, ä and ö carry meaning in Swedish. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[“”"']/g, ' ').replace(/\s+/g, ' ').trim()
}

// Words that name the person's taste or visual identity.
const TASTE_NOUNS =
  /\b(taste|tastes|preferences?|aesthetics?|aesthetic sense|visual identity|artistic identity|creative identity|artistic (?:style|voice|personality|sensibility)|visual (?:style|world|language|voice|personality|sensibility)|sensibility|smak|smaken|smaker|preferenser|estetik|estetiken|estetiska|konstnärlig identitet|visuell identitet|konstnärlig stil|visuell stil|visuella värld|bildsmak|konstsmak)\b/
// "what do I like", "what am I drawn to" and so on: taste without the word taste.
const TASTE_PHRASES =
  /\b(what (?:do|did|kind of|sort of|type of) (?:i|we) (?:like|love|enjoy|prefer|gravitate|respond)|what (?:am|are) i (?:drawn|attracted|into)|what (?:kind of|sort of|type of) (?:art|images?|pictures?|things?) (?:do|am) i|what does (?:this|that|it|my \w+) (?:say|tell|reveal) about me|who am i (?:as|visually)|how would you describe me|describe me|(?:my|me and my) (?:eye|look|vibe)|drawn to|gravitate|vad (?:gillar|älskar|föredrar|tycker) jag|vad (?:är|har) jag för|vad dras jag|vad attraheras jag|dras (?:jag|mot|till)|vad säger (?:det|detta|mina \w+) om mig|beskriv mig|vem är jag (?:som|visuellt)|vad gillar jag|vad tilltalar mig|tilltalar mig)\b/
// "style" counts as taste only when it belongs to the person.
const OWN_STYLE = /\b(my|mine|min|mitt|mina|vår|our)\b[^.?!]{0,25}\b(style|stil|look|eye|ögon|vibe|riktning|direction)\b|\b(style|stil)\b[^.?!]{0,12}\b(of mine|av mig)\b/

const SELF = /\b(i|i'm|im|i've|me|my|mine|myself|jag|mig|min|mitt|mina|mig själv|vi|vår|vårt|våra|our)\b/

const QUESTION_FORM =
  /^(what|what's|whats|which|who|how|why|do you|can you tell|could you tell|tell me|describe|explain|analy[sz]e|summari[sz]e|am i|are my|is my|vad|vilken|vilket|vilka|vem|hur|varför|berätta|beskriv|förklara|analysera|sammanfatta|har jag|är min|är mitt|är mina|kan du berätta)\b/

// Cues that ask for pictures.
const FIND_VERB = /^(?:please |kan du |could you |can you |snälla )?(?:find|show|search|look for|get|pull up|display|fetch|list|hitta|visa|sök|leta|hämta|ta fram)\b/
const IMAGE_NOUN = /\b(images?|pictures?|photos?|photographs?|paintings?|artworks?|shots?|bilder|bild|foton|foto|målningar|målning|konstverk)\b/
const WITHOUT_VERB_SEARCH = /\b(images?|pictures?|photos?|bilder|foton)\s+(of|with|about|showing|that|where|in|på|med|som|av)\b/

// Direct questions about the person, which are never a search even when an image word appears.
const ABOUT_ME_FRAME = /\b(about me|om mig|say about me|says about me|reveal about me|säger om mig)\b/

export function readIntent(raw: string): IntentReading {
  const q = normalise(raw)
  let taste = 0
  let search = 0

  const hasTasteNoun = TASTE_NOUNS.test(q)
  const hasPhrase = TASTE_PHRASES.test(q)
  const asked = QUESTION_FORM.test(q) || /\?\s*$/.test(raw.trim())
  const own = OWN_STYLE.test(q) || (SELF.test(q) && asked && /\b(style|stil)\b/.test(q))
  const self = SELF.test(q)
  const question = QUESTION_FORM.test(q) || /\?\s*$/.test(raw.trim())
  const findVerb = FIND_VERB.test(q)
  const imageNoun = IMAGE_NOUN.test(q)

  if (hasTasteNoun) taste += 2
  if (hasPhrase) taste += 3
  if (own) taste += 2
  if (self && (hasTasteNoun || hasPhrase || own)) taste += 2
  if (question && (hasTasteNoun || hasPhrase || own)) taste += 1
  if (ABOUT_ME_FRAME.test(q)) taste += question ? 4 : 2

  if (findVerb) search += 2
  if (imageNoun) search += 1
  if (findVerb && imageNoun) search += 1
  if (WITHOUT_VERB_SEARCH.test(q)) search += 2
  // A bare descriptive phrase with no sentence structure ("foggy forest", "dimmig skog") is a search too.
  if (!question && !findVerb && !self && !hasTasteNoun && !hasPhrase && q.split(' ').length <= 6) search += 2

  // "find images that match my taste" asks for pictures chosen by taste: genuinely two things, so it is mixed.
  let intent: TasteIntent = 'other'
  if (taste >= 4 && search < 3) intent = 'taste'
  else if (taste >= 4 && search >= 3) intent = taste - search >= 3 ? 'taste' : 'ambiguous'
  else if (search >= 2 && taste < 4) intent = 'search'
  // A question about oneself with no recognisable subject should be clarified, not searched.
  if (intent === 'other' && question && self && !imageNoun && !findVerb) intent = 'ambiguous'
  return { intent, taste, search }
}
