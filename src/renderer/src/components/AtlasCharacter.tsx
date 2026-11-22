export type CharacterMood = 'idle' | 'thinking' | 'happy' | 'curious' | 'sleepy' | 'hello'

/**
 * Atlas as a small character: a round lantern with an aperture on its head and two attentive eyes. It is drawn with
 * a few shapes in the app's own gold and ink, moves slowly, and shows what it is doing (thinking, pleased, curious)
 * without ever demanding attention.
 */
export function AtlasCharacter({ mood = 'idle', size = 56, label }: { mood?: CharacterMood; size?: number; label?: string }): React.JSX.Element {
  return (
    <svg
      className={`atlas-character atlas-character--${mood}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* the aperture crown */}
      <g className="atlas-character__crown" transform="translate(32 9)">
        <circle r="4.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M0-4.6 2.6 0M4 -2.3 0 2.6M4 2.3-2.6 3.8M0 4.6-2.6 0M-4-2.3 0-2.6" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
      </g>
      <path d="M32 13.6v4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* body */}
      <g className="atlas-character__body">
        <ellipse cx="32" cy="38" rx="21" ry="19.5" className="atlas-character__shell" />
        <ellipse cx="32" cy="38" rx="21" ry="19.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M13.5 41c6 4.2 11.4 5.3 18.5 5.3S44.5 45.2 50.5 41" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1" />
        {/* eyes */}
        <g className="atlas-character__eyes">
          <ellipse className="atlas-character__eye atlas-character__eye--l" cx="23.5" cy="35" rx="3.3" ry="4.2" fill="currentColor" />
          <ellipse className="atlas-character__eye atlas-character__eye--r" cx="40.5" cy="35" rx="3.3" ry="4.2" fill="currentColor" />
          <circle className="atlas-character__glint" cx="24.6" cy="33.5" r="1" />
          <circle className="atlas-character__glint" cx="41.6" cy="33.5" r="1" />
        </g>
        <g className="atlas-character__smile-eyes" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M20.5 36.2q3-4.2 6 0" />
          <path d="M37.5 36.2q3-4.2 6 0" />
        </g>
        <path className="atlas-character__mouth" d="M28 44.4q4 3.2 8 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle className="atlas-character__blush" cx="17.5" cy="42" r="2.6" />
        <circle className="atlas-character__blush" cx="46.5" cy="42" r="2.6" />
      </g>
    </svg>
  )
}
