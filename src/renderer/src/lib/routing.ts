export type RouteName =
  | 'collection'
  | 'recent'
  | 'favorites'
  | 'review'
  | 'archive'
  | 'families'
  | 'smart'
  | 'taste'
  | 'taste-classic'
  | 'moodboards'
  | 'moodboard'
  | 'sources'
  | 'organizer'

export interface Route {
  name: RouteName
  boardId?: string
  planId?: string
}

export function parseRoute(hash: string): Route {
  const cleaned = hash.replace(/^#\/?/, '')
  const [name, id] = cleaned.split('/')
  switch (name) {
    case 'recent':
    case 'favorites':
    case 'review':
    case 'archive':
    case 'families':
    case 'smart':
    case 'taste':
    case 'taste-classic':
    case 'sources':
      return { name }
    case 'organizer':
      return id ? { name: 'organizer', planId: decodeURIComponent(id) } : { name: 'organizer' }
    case 'moodboards':
      return { name: 'moodboards' }
    case 'moodboard':
      return id ? { name: 'moodboard', boardId: decodeURIComponent(id) } : { name: 'moodboards' }
    default:
      return { name: 'collection' }
  }
}

export function routeHash(route: Route): string {
  if (route.name === 'moodboard' && route.boardId) return `#/moodboard/${encodeURIComponent(route.boardId)}`
  if (route.name === 'organizer' && route.planId) return `#/organizer/${encodeURIComponent(route.planId)}`
  return `#/${route.name}`
}

export function routeLabel(route: Route): string {
  const labels: Record<RouteName, string> = {
    collection: 'Collection',
    recent: 'Recently added',
    favorites: 'Favorites',
    review: 'Review Room',
    archive: 'Archive',
    families: 'Families',
    smart: 'Smart Collections',
    taste: 'Taste',
    'taste-classic': 'Taste (classic)',
    moodboards: 'Moodboards',
    moodboard: 'Moodboard',
    sources: 'Sources',
    organizer: 'Smart Organizer'
  }
  return labels[route.name]
}

export const NAV_ITEMS: Array<{ route: RouteName; label: string }> = [
  { route: 'collection', label: 'Collection' },
  { route: 'recent', label: 'Recently added' },
  { route: 'favorites', label: 'Favorites' },
  { route: 'review', label: 'Review Room' },
  { route: 'archive', label: 'Archive' },
  { route: 'families', label: 'Families' },
  { route: 'smart', label: 'Smart Collections' },
  { route: 'taste', label: 'Taste' },
  { route: 'moodboards', label: 'Moodboards' },
  { route: 'organizer', label: 'Smart Organizer' },
  { route: 'sources', label: 'Sources' }
]
