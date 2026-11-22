import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const buildDir = resolve('build')
const svg = await readFile(resolve(buildDir, 'icon.svg'))
await mkdir(buildDir, { recursive: true })

await sharp(svg).resize(512, 512).png().toFile(resolve(buildDir, 'icon.png'))

const sizes = [256, 128, 64, 48, 32, 16]
const images = []
for (const size of sizes) {
  images.push({ size, data: await sharp(svg).resize(size, size).png().toBuffer() })
}

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

const directory = Buffer.alloc(images.length * 16)
let offset = 6 + directory.length
for (const [index, image] of images.entries()) {
  const entry = index * 16
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry)
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1)
  directory.writeUInt8(0, entry + 2)
  directory.writeUInt8(0, entry + 3)
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(image.data.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += image.data.length
}

await writeFile(resolve(buildDir, 'icon.ico'), Buffer.concat([header, directory, ...images.map((image) => image.data)]))
console.log(`Wrote build/icon.png (512) and build/icon.ico (${sizes.join(', ')}).`)
