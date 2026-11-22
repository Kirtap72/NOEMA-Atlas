import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const palettes = [
  ['#1a1712', '#7b4b24', '#e5b566'],
  ['#111820', '#2f5368', '#a5c3ce'],
  ['#191410', '#653e36', '#d6a789'],
  ['#141a16', '#4e624a', '#c8c19c'],
  ['#1b141f', '#5d3c64', '#d8b6c9'],
  ['#17130d', '#8a642f', '#f0d295'],
  ['#0f1718', '#3e6f6c', '#b4d4c8']
]

export async function ensureE2eFixtures(fixturesDir = resolve('.e2e/images'), minimum = 20) {
  await fs.mkdir(fixturesDir, { recursive: true })
  const existing = (await fs.readdir(fixturesDir)).filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
  if (existing.length >= minimum) return { generated: false, count: existing.length }

  console.log('Preparing synthetic E2E images…')
  for (let index = 0; index < 28; index += 1) {
    const [dark, mid, light] = palettes[index % palettes.length]
    const portrait = index % 3 === 0
    const width = portrait ? 1100 : 1600
    const height = portrait ? 1500 : 1050
    const sunX = 260 + ((index * 137) % 900) * (width / 1600)
    const sunY = 250 + ((index * 83) % 500) * (height / 1050)
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${dark}"/>
            <stop offset="0.55" stop-color="${mid}"/>
            <stop offset="1" stop-color="${dark}"/>
          </linearGradient>
          <radialGradient id="sun" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="${light}" stop-opacity="0.95"/>
            <stop offset="1" stop-color="${light}" stop-opacity="0"/>
          </radialGradient>
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>
            <feColorMatrix type="saturate" values="0"/>
            <feComponentTransfer><feFuncA type="linear" slope="0.12"/></feComponentTransfer>
          </filter>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#bg)"/>
        <circle cx="${sunX}" cy="${sunY}" r="${width * 0.34}" fill="url(#sun)"/>
        <circle cx="${sunX}" cy="${sunY}" r="${width * 0.09}" fill="${light}" opacity="0.75"/>
        <path d="M${width * 0.16} ${height} V${height * 0.38} Q${width * 0.16} ${height * 0.18} ${width * 0.5} ${height * 0.18} Q${width * 0.84} ${height * 0.18} ${width * 0.84} ${height * 0.38} V${height}" fill="none" stroke="${light}" stroke-opacity="0.2" stroke-width="2"/>
        <path d="M${width * 0.08} ${height * 0.74} Q${width * 0.5} ${height * 0.62} ${width * 0.92} ${height * 0.8}" fill="none" stroke="${light}" stroke-opacity="0.18" stroke-width="1"/>
        <rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.4"/>
      </svg>`
    await sharp(Buffer.from(svg))
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(resolve(fixturesDir, `${String(index + 1).padStart(2, '0')}-surreal-study-${index + 1}.jpg`))
  }
  console.log('  prepared 28 synthetic images')
  return { generated: true, count: 28 }
}
