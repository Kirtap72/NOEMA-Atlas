// The curation plan for the Atlas Reference Collection: a broad, balanced set of artworks that every user sees,
// independent of what is stored on their own computer.
//
// Only works that a museum itself publishes as public domain / CC0 are eligible:
//   - Art Institute of Chicago public-domain collection (is_public_domain = true), CC0 1.0
//   - Cleveland Museum of Art Open Access (share_license_status = "CC0"), CC0 1.0
//   - The Metropolitan Museum of Art Open Access (isPublicDomain = true), CC0 1.0 (used gently, when reachable)
//
// A shelf is a human-chosen slice of art history, not an aesthetic judgement: each shelf names where its works come
// from (a museum department, a period, a kind of object), and a work's shelf is recorded in its provenance.

export const LICENSE = {
  id: 'CC0-1.0',
  name: 'CC0 1.0 Universal (Public Domain Dedication)',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/'
}

// aic(): cls = classification_title values, style = style_title, dept = department_title, from/to = date_start/date_end
// cma(): type, dept (department), culture, from/to (creation years), q = free text
// met(): dept = Met department id, q required, dateBegin/dateEnd, artist = search artist names
const aic = (q, o = {}) => ({ m: 'aic', q, ...o })
const cma = (q, o = {}) => ({ m: 'cma', q, ...o })
const met = (q, dept, o = {}) => ({ m: 'met', q, dept, ...o })

const PAINTING = ['painting', 'oil on canvas', 'oil on panel', 'tempera', 'oil on copper']
const PHOTO = ['photograph', 'albumen silver print', 'gelatin silver print', 'salted paper print', 'photography', 'platinum print', 'carbon print', 'daguerreotype', 'cyanotype', 'photogravure']
const PRINT = ['etching', 'woodblock print', 'lithograph', 'engraving', 'woodcut', 'drypoint', 'aquatint', 'wood engraving', 'print', 'mezzotint', 'color woodblock print']
const DRAWING = ['pen and ink drawings', 'chalk', 'graphite', 'ink or chalk wash', 'watercolor', 'drawings (visual works)', 'charcoal', 'drawing', 'pastel']
const SCULPTURE = ['sculpture', 'bronze', 'marble', 'statue', 'relief']

/** group: the broad kind of object, used to avoid unfair comparisons (a print against a statue) in some modes. */
export const SHELVES = [
  // ---- Western painting through time -------------------------------------------------------------
  { id: 'medieval-panel', label: 'Medieval and early Renaissance painting', group: 'painting', target: 30, sources: [aic('', { cls: PAINTING, dept: 'Painting and Sculpture of Europe', from: 1100, to: 1480 }), cma('', { type: 'Painting', dept: 'Medieval Art' }), cma('', { type: 'Painting', dept: 'European Painting and Sculpture', from: 1250, to: 1480 }), met('painting', 11, { dateBegin: 1200, dateEnd: 1450 })] },
  { id: 'renaissance', label: 'Renaissance painting', group: 'painting', target: 36, sources: [aic('', { cls: PAINTING, dept: 'Painting and Sculpture of Europe', from: 1480, to: 1600 }), cma('', { type: 'Painting', dept: 'European Painting and Sculpture', from: 1480, to: 1600 }), met('oil', 11, { dateBegin: 1450, dateEnd: 1580 })] },
  { id: 'baroque', label: 'Baroque painting', group: 'painting', target: 36, sources: [aic('', { cls: PAINTING, dept: 'Painting and Sculpture of Europe', from: 1600, to: 1720 }), cma('', { type: 'Painting', dept: 'European Painting and Sculpture', from: 1600, to: 1720 }), met('oil', 11, { dateBegin: 1580, dateEnd: 1700 })] },
  { id: 'dutch-landscape', label: 'Dutch and Flemish painting', group: 'painting', target: 24, sources: [cma('', { type: 'Painting', culture: 'Netherlands' }), aic('dutch', { cls: PAINTING }), met('landscape', 11, { dateBegin: 1600, dateEnd: 1700 })] },
  { id: 'still-life', label: 'Still life', group: 'painting', target: 26, sources: [aic('still life', { cls: PAINTING }), cma('still life', { type: 'Painting' }), met('still life', 11)] },
  { id: 'rococo-neoclassical', label: 'Rococo and Neoclassical painting', group: 'painting', target: 28, sources: [aic('', { cls: PAINTING, dept: 'Painting and Sculpture of Europe', from: 1720, to: 1810 }), cma('', { type: 'Painting', dept: 'European Painting and Sculpture', from: 1720, to: 1810 }), met('oil', 11, { dateBegin: 1700, dateEnd: 1800 })] },
  { id: 'romantic-landscape', label: 'Romantic and sublime landscape', group: 'painting', target: 36, sources: [aic('landscape', { cls: PAINTING, from: 1790, to: 1880 }), cma('landscape', { type: 'Painting', from: 1790, to: 1880 }), met('landscape', 11, { dateBegin: 1790, dateEnd: 1870 }), met('landscape', 1, { dateBegin: 1800, dateEnd: 1880 })] },
  { id: 'realism-barbizon', label: 'Realism and the Barbizon school', group: 'painting', target: 28, sources: [aic('', { cls: PAINTING, dept: 'Painting and Sculpture of Europe', from: 1830, to: 1870 }), cma('', { type: 'Painting', culture: 'France', from: 1830, to: 1870 })] },
  { id: 'impressionism', label: 'Impressionism', group: 'painting', target: 36, sources: [aic('', { style: 'Impressionism' }), cma('impressionist', { type: 'Painting', from: 1860, to: 1900 }), met('impressionist', 11, { dateBegin: 1860, dateEnd: 1900 })] },
  { id: 'post-impressionism', label: 'Post-Impressionism and Symbolism', group: 'painting', target: 32, sources: [aic('', { style: 'Post-Impressionism' }), aic('symbolism', { cls: PAINTING, from: 1880, to: 1915 }), cma('symbolist', { type: 'Painting' })] },
  { id: 'american-painting', label: 'American painting', group: 'painting', target: 30, sources: [cma('', { type: 'Painting', dept: 'American Painting and Sculpture' }), aic('american', { cls: PAINTING, from: 1750, to: 1930 }), met('painting', 1, { dateBegin: 1750, dateEnd: 1930 })] },
  { id: 'early-modern', label: 'Expressionism and early modern painting', group: 'painting', target: 32, sources: [cma('', { type: 'Painting', dept: 'Modern European Painting and Sculpture' }), aic('modern', { cls: PAINTING, from: 1895, to: 1950 }), met('modern', 21, { dateBegin: 1890, dateEnd: 1945 })] },
  { id: 'abstraction', label: 'Abstraction and geometric form', group: 'painting', target: 30, sources: [cma('abstract', { type: 'Painting', from: 1900, to: 1990 }), aic('abstract', { cls: PAINTING }), aic('geometric abstraction', {}), met('abstract', 21), met('geometric', 21)] },
  { id: 'fantastic', label: 'Surreal, dreamlike and fantastic imagery', group: 'drawing', target: 30, sources: [aic('Redon', {}), aic('Ensor', {}), aic('Blake', {}), aic('Fuseli', {}), aic('dream fantastic nightmare', { cls: [...PAINTING, ...PRINT, ...DRAWING] }), cma('Redon', {}), cma('fantastic dream', { type: 'Print' }), met('Redon', 9, { artist: true }), met('Fuseli', 9, { artist: true })] },
  { id: 'portrait', label: 'Portraiture', group: 'painting', target: 28, sources: [aic('portrait', { cls: PAINTING }), cma('portrait', { type: 'Painting' }), met('portrait', 11)] },

  // ---- Works on paper ----------------------------------------------------------------------------
  { id: 'ukiyo-e', label: 'Japanese woodblock prints (ukiyo-e)', group: 'print', target: 34, sources: [aic('landscape', { cls: ['woodblock print', 'color woodblock print'] }), cma('', { type: 'Print', dept: 'Japanese Art' }), met('woodblock print', 6)] },
  { id: 'european-prints', label: 'European etchings and engravings', group: 'print', target: 32, sources: [aic('', { cls: ['etching', 'engraving', 'drypoint', 'aquatint', 'mezzotint'], dept: 'Prints and Drawings', from: 1450, to: 1900 }), cma('', { type: 'Print', dept: 'Prints', from: 1450, to: 1900 })] },
  { id: 'drawings', label: 'Drawings and watercolours', group: 'drawing', target: 28, sources: [aic('', { cls: DRAWING, dept: 'Prints and Drawings', from: 1400, to: 1930 }), cma('', { type: 'Drawing' }), met('drawing', 9)] },
  { id: 'posters-graphic', label: 'Posters and graphic design', group: 'print', target: 26, sources: [aic('poster', { cls: ['lithograph', 'poster', 'print'], from: 1880, to: 1940 }), cma('poster', { type: 'Print' }), met('poster', 9)] },
  { id: 'botanical-natural', label: 'Botanical and natural-history illustration', group: 'drawing', target: 24, sources: [aic('botanical', {}), aic('birds animals natural history', { cls: [...PRINT, ...DRAWING] }), cma('botanical', {}), met('botanical', 9)] },

  // ---- Asian art ---------------------------------------------------------------------------------
  { id: 'chinese-painting', label: 'Chinese painting and calligraphy', group: 'painting', target: 30, sources: [cma('', { type: 'Painting', culture: 'China' }), aic('chinese landscape', { dept: 'Arts of Asia', cls: [...PAINTING, 'ink on paper', 'hanging scroll'] }), met('landscape', 6, { dateBegin: 900, dateEnd: 1900, medium: 'Ink' })] },
  { id: 'japanese-painting', label: 'Japanese screens, scrolls and painting', group: 'painting', target: 26, sources: [cma('', { type: 'Painting', culture: 'Japan' }), met('screen', 6), met('hanging scroll Japan', 6)] },
  { id: 'indian-persian-miniature', label: 'Indian and Persian miniature painting', group: 'painting', target: 28, sources: [cma('', { type: 'Painting', culture: 'India' }), aic('miniature', { cls: ['miniature painting'] }), met('miniature', 6)] },
  { id: 'asian-sculpture', label: 'Asian sculpture', group: 'sculpture', target: 26, sources: [cma('', { type: 'Sculpture', dept: 'Indian and Southeast Asian Art' }), cma('', { type: 'Sculpture', dept: 'Chinese Art' }), cma('', { type: 'Sculpture', dept: 'Japanese Art' }), met('Buddha', 6)] },
  { id: 'east-asian-ceramics', label: 'East Asian ceramics, jade and bronzes', group: 'object', target: 24, sources: [cma('', { type: 'Ceramic', dept: 'Chinese Art' }), cma('', { type: 'Ceramic', dept: 'Japanese Art' }), cma('', { type: 'Ceramic', dept: 'Korean Art' }), aic('', { dept: 'Arts of Asia', cls: ['porcelain', 'stoneware', 'ceramic', 'jade'] })] },

  // ---- Islamic art --------------------------------------------------------------------------------
  { id: 'islamic-pattern', label: 'Islamic manuscripts, tiles and geometric pattern', group: 'object', target: 28, sources: [cma('', { dept: 'Islamic Art' }), met('tile', 14), met('calligraphy', 14)] },

  // ---- Ancient and world art ---------------------------------------------------------------------
  { id: 'egyptian', label: 'Egyptian art', group: 'object', target: 26, sources: [cma('', { dept: 'Egyptian and Ancient Near Eastern Art' }), aic('egyptian', { style: 'egyptian' }), met('relief', 10), met('statue', 10)] },
  { id: 'greek-roman-sculpture', label: 'Greek and Roman sculpture', group: 'sculpture', target: 26, sources: [cma('', { type: 'Sculpture', dept: 'Greek and Roman Art' }), aic('', { dept: 'Arts of Greece, Rome, and Byzantium', cls: SCULPTURE }), met('marble', 13)] },
  { id: 'greek-vases-mosaics', label: 'Greek vases, Roman mosaics and frescoes', group: 'object', target: 24, sources: [cma('', { type: 'Ceramic', dept: 'Greek and Roman Art' }), cma('', { type: 'Mosaic' }), aic('', { dept: 'Arts of Greece, Rome, and Byzantium', cls: ['earthenware', 'vessel', 'mosaic', 'painting'] }), met('terracotta vase', 13)] },
  { id: 'africa', label: 'African sculpture and masks', group: 'sculpture', target: 28, sources: [cma('', { dept: 'African Art' }), aic('', { dept: 'Arts of Africa' }), met('mask', 5)] },
  { id: 'oceania-americas', label: 'Native American and Oceanic art', group: 'object', target: 24, sources: [cma('', { dept: 'Art of the Americas' }), aic('native american', { dept: 'Arts of the Americas' }), met('Oceania', 5)] },
  { id: 'pre-columbian', label: 'Pre-Columbian art', group: 'object', target: 26, sources: [aic('', { dept: 'Arts of the Americas', style: 'nazca' }), aic('', { dept: 'Arts of the Americas', style: 'moche' }), aic('', { dept: 'Arts of the Americas', style: 'inca' }), cma('Pre-Columbian', {}), met('Maya', 5)] },
  { id: 'medieval-objects', label: 'Medieval manuscripts, ivories and metalwork', group: 'object', target: 26, sources: [cma('', { type: 'Manuscript' }), cma('', { dept: 'Medieval Art', type: 'Sculpture' }), cma('', { dept: 'Medieval Art', type: 'Metalwork' }), met('manuscript', 17)] },

  // ---- Sculpture ---------------------------------------------------------------------------------
  { id: 'european-sculpture', label: 'European sculpture', group: 'sculpture', target: 26, sources: [cma('', { type: 'Sculpture', dept: 'European Painting and Sculpture', from: 1400, to: 1900 }), aic('', { dept: 'Painting and Sculpture of Europe', cls: SCULPTURE }), met('marble', 12)] },
  { id: 'modern-sculpture', label: 'Modern sculpture', group: 'sculpture', target: 22, sources: [cma('', { type: 'Sculpture', from: 1880, to: 1990 }), aic('modern sculpture', { cls: SCULPTURE, from: 1880, to: 1990 }), met('sculpture', 21)] },

  // ---- Photography and architecture ------------------------------------------------------------
  { id: 'photo-19th', label: 'Nineteenth-century photography', group: 'photograph', target: 34, sources: [aic('', { cls: PHOTO, dept: 'Photography and Media', from: 1839, to: 1900 }), cma('', { type: 'Photograph', from: 1839, to: 1900 }), met('albumen', 19)] },
  { id: 'photo-early-modern', label: 'Early twentieth-century photography', group: 'photograph', target: 34, sources: [aic('', { cls: PHOTO, dept: 'Photography and Media', from: 1900, to: 1950 }), cma('', { type: 'Photograph', from: 1900, to: 1950 }), met('gelatin silver', 19, { dateBegin: 1900, dateEnd: 1945 })] },
  { id: 'photo-documentary', label: 'Documentary and street photography', group: 'photograph', target: 26, sources: [aic('street documentary city', { cls: PHOTO }), aic('Lange', {}), aic('Evans', { cls: PHOTO }), cma('documentary', { type: 'Photograph' }), met('Walker Evans', 19, { artist: true })] },
  { id: 'architecture', label: 'Architecture: drawings, plans and photographs', group: 'architecture', target: 32, sources: [aic('', { dept: 'Architecture and Design' }), aic('architecture building', { cls: [...PHOTO, ...PRINT, ...DRAWING] }), cma('architecture', { type: 'Print' }), met('Piranesi', 9, { artist: true })] },

  // ---- Design and decorative art -----------------------------------------------------------------
  { id: 'art-nouveau-crafts', label: 'Art Nouveau, Arts and Crafts and design', group: 'object', target: 30, sources: [aic('', { style: 'Arts and Crafts Movement' }), aic('art nouveau', {}), cma('', { dept: 'Decorative Art and Design', from: 1880, to: 1940 }), met('Tiffany', 1, { artist: true })] },
  { id: 'textiles-costume', label: 'Textiles', group: 'textile', target: 26, sources: [aic('', { dept: 'Textiles', from: 1300, to: 1950 }), cma('', { type: 'Textile' }), met('textile', 8)] },
  { id: 'furniture-interiors', label: 'Furniture and interiors', group: 'object', target: 20, sources: [aic('furniture chair cabinet', { dept: 'Applied Arts of Europe' }), cma('chair cabinet', { dept: 'Decorative Art and Design' }), met('cabinet', 12)] },
  { id: 'glass-ceramics', label: 'Glass and ceramics', group: 'object', target: 26, sources: [cma('', { type: 'Glass' }), aic('', { dept: 'Applied Arts of Europe', cls: ['glass', 'porcelain', 'earthenware', 'vessel'] }), cma('', { type: 'Ceramic', dept: 'Decorative Art and Design' })] },
  { id: 'jewelry-metalwork', label: 'Jewelry and metalwork', group: 'object', target: 22, sources: [cma('', { type: 'Jewelry' }), cma('', { type: 'Metalwork', dept: 'Decorative Art and Design' }), met('jewelry', 12)] }
]
