/**
 * The plain-language vocabulary used to name image families. Each term is a short description that the local image
 * model (SigLIP) can match against an image. Terms are grouped by what they describe, and each carries the wording
 * needed to build a natural name from it:
 *
 *  - subject:     `label` is a plural noun phrase ("mountain landscapes")
 *  - atmosphere / colour / style: `adjective` goes in front of a subject ("misty", "watercolor"), `label` stands alone
 *    ("black-and-white photographs").
 *
 * This is a vocabulary of everyday descriptions, not of judgements: nothing here says an image is good or bad.
 */
export type TermKind = 'subject' | 'atmosphere' | 'style' | 'colour'

export interface VocabTerm {
  id: string
  kind: TermKind
  /** What is sent to the text model. */
  prompt: string
  /** Standalone wording, lower case. */
  label: string
  /** Wording that can precede a noun, for atmosphere, colour and style terms. */
  adjective?: string
  /** Subjects that are so broad that naming them adds little ("scenes"). They are only used when nothing else fits. */
  generic?: boolean
  /** For subjects: the broader kind of subject, used to name a family whose images agree on the kind but not the detail. */
  group?: string
}

/** Wording for each broader subject group, used when a family agrees on the kind of subject but not on which one. */
export const SUBJECT_GROUPS: Record<string, string> = {
  scenery: 'landscapes',
  built: 'buildings and city scenes',
  people: 'people',
  animals: 'animals',
  fantasy: 'fantasy scenes',
  machines: 'vehicles and machines',
  objects: 'objects and still lifes',
  abstract: 'abstract images and patterns'
}

const subject = (id: string, phrase: string, label: string, generic = false, group?: string): VocabTerm => ({ id, kind: 'subject', prompt: `an image of ${phrase}`, label, generic, group })
const mood = (id: string, phrase: string, label: string, adjective: string): VocabTerm => ({ id, kind: 'atmosphere', prompt: `an image with a ${phrase} atmosphere`, label, adjective })
const style = (id: string, phrase: string, label: string, adjective: string): VocabTerm => ({ id, kind: 'style', prompt: phrase, label, adjective })
const colour = (id: string, phrase: string, label: string, adjective: string): VocabTerm => ({ id, kind: 'colour', prompt: `an image dominated by ${phrase}`, label, adjective })

export const FAMILY_VOCABULARY: VocabTerm[] = [
  // ---- subjects --------------------------------------------------------------------------------------------
  subject('landscape', 'a wide landscape with land and sky', 'landscapes', false, 'scenery'),
  subject('mountains', 'mountains', 'mountain scenes', false, 'scenery'),
  subject('forest', 'a forest with many trees', 'forests', false, 'scenery'),
  subject('trees', 'a single tree or a few trees', 'trees', false, 'scenery'),
  subject('sea', 'the sea and a coast', 'sea and coast scenes', false, 'scenery'),
  subject('beach', 'a beach with sand', 'beaches', false, 'scenery'),
  subject('river', 'a river or a lake', 'rivers and lakes', false, 'scenery'),
  subject('waterfall', 'a waterfall', 'waterfalls', false, 'scenery'),
  subject('desert', 'a desert with dunes', 'deserts', false, 'scenery'),
  subject('sky', 'the sky with clouds', 'skies and clouds', false, 'scenery'),
  subject('sunset', 'a sunset or a sunrise', 'sunsets', false, 'scenery'),
  subject('night-sky', 'a night sky with stars and the moon', 'night skies', false, 'scenery'),
  subject('snow', 'snow and ice in winter', 'winter scenes', false, 'scenery'),
  subject('fields', 'fields and farmland', 'fields and farmland', false, 'scenery'),
  subject('garden', 'a garden', 'gardens', false, 'scenery'),
  subject('flowers', 'flowers', 'flowers', false, 'scenery'),
  subject('city', 'a city street with buildings', 'city streets', false, 'built'),
  subject('skyline', 'a city skyline with tall buildings', 'city skylines', false, 'built'),
  subject('architecture', 'a building or a piece of architecture', 'buildings and architecture', false, 'built'),
  subject('ruins', 'ancient ruins', 'ruins', false, 'built'),
  subject('castle', 'a castle or a fortress', 'castles', false, 'built'),
  subject('bridge', 'a bridge', 'bridges', false, 'built'),
  subject('interior', 'the inside of a room', 'interiors', false, 'built'),
  subject('portrait', 'a portrait of a person', 'portraits', false, 'people'),
  subject('woman', 'a woman', 'women', false, 'people'),
  subject('man', 'a man', 'men', false, 'people'),
  subject('child', 'a child', 'children', false, 'people'),
  subject('crowd', 'a crowd of many people', 'crowds', false, 'people'),
  subject('figure', 'a lone figure in a large space', 'lone figures', false, 'people'),
  subject('face', 'a close-up of a face', 'faces', false, 'people'),
  subject('eye', 'an eye', 'eyes', false, 'people'),
  subject('hands', 'hands', 'hands', false, 'people'),
  subject('dancer', 'a dancer', 'dancers', false, 'people'),
  subject('warrior', 'a warrior or a knight in armor', 'warriors', false, 'people'),
  subject('animal', 'an animal', 'animals', false, 'animals'),
  subject('bird', 'a bird', 'birds', false, 'animals'),
  subject('horse', 'a horse', 'horses', false, 'animals'),
  subject('dog', 'a dog', 'dogs', false, 'animals'),
  subject('cat', 'a cat', 'cats', false, 'animals'),
  subject('sea-creature', 'a fish or a sea creature', 'sea creatures', false, 'animals'),
  subject('insect', 'an insect', 'insects', false, 'animals'),
  subject('dragon', 'a dragon or a mythical creature', 'mythical creatures', false, 'fantasy'),
  subject('monster', 'a monster or a demon', 'monsters', false, 'fantasy'),
  subject('robot', 'a robot or a machine', 'robots and machines', false, 'machines'),
  subject('spaceship', 'a spaceship in science fiction', 'science-fiction scenes', false, 'machines'),
  subject('space', 'planets and outer space', 'space scenes', false, 'machines'),
  subject('car', 'a car or a vehicle', 'vehicles', false, 'machines'),
  subject('boat', 'a boat or a ship', 'boats and ships', false, 'machines'),
  subject('train', 'a train', 'trains', false, 'machines'),
  subject('food', 'food on a table', 'food', false, 'objects'),
  subject('still-life', 'a still life with objects arranged on a table', 'still lifes', false, 'objects'),
  subject('statue', 'a statue or a sculpture', 'statues and sculptures', false, 'objects'),
  subject('abstract', 'abstract shapes and forms', 'abstract compositions', false, 'abstract'),
  subject('pattern', 'a repeating pattern or a texture', 'patterns and textures', false, 'abstract'),
  subject('text', 'text, letters and typography', 'typography', false, 'abstract'),
  subject('fantasy', 'a fantasy world with magic', 'fantasy scenes', false, 'fantasy'),
  subject('gothic', 'a gothic scene with skulls and darkness', 'gothic scenes', false, 'fantasy'),
  subject('angel', 'an angel or a religious scene', 'angels and religious scenes', false, 'fantasy'),
  subject('fashion', 'a person wearing fashionable clothes', 'fashion', false, 'people'),
  subject('jewelry', 'jewelry', 'jewelry', false, 'objects'),
  subject('book', 'books and paper', 'books and paper', false, 'objects'),
  subject('window', 'a door, a window or a staircase', 'doors, windows and stairs', false, 'built'),
  subject('mask', 'a mask', 'masks', false, 'fantasy'),
  subject('clock', 'a clock', 'clocks', false, 'objects'),
  subject('light-beams', 'rays of light through darkness', 'rays of light', false, 'objects'),
  subject('scene', 'a scene', 'scenes', true),

  // ---- atmosphere ---------------------------------------------------------------------------------------------
  mood('misty', 'misty and foggy', 'misty scenes', 'misty'),
  mood('moody', 'dark and moody', 'moody images', 'dark and moody'),
  mood('bright', 'bright and airy', 'bright, airy images', 'bright'),
  mood('golden', 'warm golden-hour', 'golden-lit images', 'golden-lit'),
  mood('dreamlike', 'dreamlike and surreal', 'dreamlike images', 'dreamlike'),
  mood('melancholy', 'melancholic and lonely', 'melancholic images', 'melancholic'),
  mood('serene', 'calm and serene', 'serene images', 'serene'),
  mood('dramatic', 'dramatic and intense', 'dramatic images', 'dramatic'),
  mood('eerie', 'eerie and mysterious', 'eerie images', 'eerie'),
  mood('cosy', 'cosy and warm', 'cosy images', 'cosy'),
  mood('vibrant', 'vibrant and lively', 'vibrant images', 'vibrant'),
  mood('stormy', 'stormy and gloomy', 'stormy images', 'stormy'),
  mood('romantic', 'romantic and tender', 'romantic images', 'romantic'),
  mood('minimal', 'minimal and quiet', 'minimal images', 'minimal'),
  { id: 'futuristic', kind: 'atmosphere', prompt: 'a futuristic science-fiction scene with advanced technology and neon lights', label: 'futuristic images', adjective: 'futuristic' },
  mood('epic', 'epic and grand', 'epic images', 'epic'),

  // ---- style and medium -------------------------------------------------------------------------------------------
  style('oil', 'an oil painting', 'oil paintings', 'painted'),
  style('watercolor', 'a watercolor painting', 'watercolors', 'watercolor'),
  style('sketch', 'a pencil sketch', 'pencil sketches', 'sketched'),
  style('ink', 'an ink drawing', 'ink drawings', 'ink-drawn'),
  style('bw-photo', 'a black and white photograph', 'black-and-white photographs', 'black-and-white'),
  style('photo', 'a photograph taken with a camera', 'photographs', 'photographic'),
  style('cinematic', 'a cinematic film still', 'cinematic stills', 'cinematic'),
  style('macro', 'a macro photograph of something very small', 'macro photographs', 'close-up'),
  style('vintage', 'an old vintage photograph', 'vintage photographs', 'vintage'),
  style('render', 'a 3D render', '3D renders', '3D-rendered'),
  style('digital', 'a digital illustration', 'digital illustrations', 'illustrated'),
  style('anime', 'an anime illustration', 'anime-style illustrations', 'anime-style'),
  style('pixel', 'pixel art', 'pixel art', 'pixel-art'),
  style('collage', 'a collage of different pieces', 'collages', 'collage'),
  style('line', 'minimal line art', 'line art', 'line-art'),
  style('concept', 'concept art for a game or film', 'concept art', 'concept-art'),
  style('comic', 'a comic book illustration', 'comic-style art', 'comic-style'),
  style('woodcut', 'a woodcut or an etching print', 'prints', 'printed'),

  // ---- colour -----------------------------------------------------------------------------------------------------------
  colour('red', 'red and crimson tones', 'red-toned images', 'red-toned'),
  colour('orange', 'orange and amber tones', 'orange-toned images', 'orange-toned'),
  colour('yellow', 'yellow and gold tones', 'gold-toned images', 'gold-toned'),
  colour('green', 'green tones', 'green-toned images', 'green-toned'),
  colour('teal', 'teal and turquoise tones', 'teal-toned images', 'teal-toned'),
  colour('blue', 'blue tones', 'blue-toned images', 'blue-toned'),
  colour('purple', 'purple and violet tones', 'purple-toned images', 'purple-toned'),
  colour('pink', 'pink tones', 'pink-toned images', 'pink-toned'),
  colour('pastel', 'soft pastel colors', 'pastel images', 'pastel'),
  colour('mono', 'a single color on a plain grey scale', 'monochrome images', 'monochrome'),
  colour('earth', 'brown and earthy tones', 'earth-toned images', 'earth-toned'),
  colour('neon', 'bright neon colors', 'neon images', 'neon')
]
