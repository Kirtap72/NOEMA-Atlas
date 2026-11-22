import { promises as fs } from 'node:fs'
import { relative, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { ensureE2eFixtures } from './fixtures.mjs'
import { waitForScanComplete as waitForScan } from './wait.mjs'

const root = resolve('.')
const electronPath = resolve('node_modules/electron/dist/electron.exe')
const screenshotsDir = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? 'docs/screenshots')
const fixtures = resolve('.e2e/images')
const filingDir = resolve('.e2e/filing-source')
const copyDir = resolve('.e2e/filed-copy')
const moveDir = resolve('.e2e/filed-move')
await fs.mkdir(screenshotsDir, { recursive: true })
await ensureE2eFixtures(fixtures)

const baseEnv = { ...process.env }
delete baseEnv.ELECTRON_RUN_AS_NODE
baseEnv.NOEMA_E2E = '1'

const consoleErrors = []
let electronApp = null
let page = null

function log(message) {
  console.log(`\n◆ ${message}`)
}

async function launch({ profile, seed }) {
  const env = {
    ...baseEnv,
    NOEMA_USER_DATA_DIR: profile
  }
  if (seed) env.NOEMA_E2E_SEED = seed
  electronApp = await electron.launch({
    executablePath: electronPath,
    args: ['.', '--force-device-scale-factor=1'],
    cwd: root,
    env,
    timeout: 60_000
  })
  electronApp.process().stdout?.on('data', (data) => process.stdout.write(`[main] ${data}`))
  electronApp.process().stderr?.on('data', (data) => process.stderr.write(`[main] ${data}`))
  page = await electronApp.firstWindow({ timeout: 60_000 })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
  })
  await page.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      window.setSize(1440, 920)
      window.center()
    }
  })
  await page.waitForTimeout(800)
  return page
}

async function close() {
  if (!electronApp) return
  await electronApp.close().catch(() => undefined)
  electronApp = null
  page = null
}

async function waitForScanComplete(expectedImages) {
  return waitForScan(page, expectedImages)
}

async function screenshot(name) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await page.waitForTimeout(500)
  await page.screenshot({ path: resolve(screenshotsDir, name), animations: 'disabled' })
  console.log(`  saved ${relative(root, resolve(screenshotsDir, name))}`)
}

async function dismissToasts() {
  for (let index = 0; index < 8; index += 1) {
    const closeButton = page.locator('.toast__close').first()
    if ((await closeButton.count()) === 0) break
    await closeButton.click().catch(() => undefined)
    await page.waitForTimeout(60)
  }
}

async function getBoard(name = 'Amber interiors') {
  return page.evaluate(async (boardName) => {
    const bootstrap = await window.noema.bootstrap()
    const board = bootstrap.moodboards.find((entry) => entry.name === boardName)
    if (!board) return null
    return window.noema.getMoodboard(board.id)
  }, name)
}

async function boardCamera() {
  return page.evaluate(() => {
    const world = document.querySelector('.board-world')
    if (!world) return null
    const matrix = new DOMMatrix(getComputedStyle(world).transform)
    return { scale: matrix.a, x: matrix.e, y: matrix.f }
  })
}

async function dragWithMouse(from, to, steps = 24) {
  const fromBox = await from.boundingBox()
  if (!fromBox) throw new Error('Drag source is not visible')
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 24, fromBox.y + fromBox.height / 2 + 24, { steps: 6 })
  await page.waitForTimeout(350)
  await page.mouse.move(to.x, to.y, { steps })
  await page.waitForTimeout(350)
  await page.mouse.up()
}

async function main() {
  const emptyProfile = resolve('.e2e/profile-welcome')
  const seededProfile = resolve('.e2e/profile')
  await fs.rm(emptyProfile, { recursive: true, force: true })
  await fs.rm(seededProfile, { recursive: true, force: true })
  await fs.rm(filingDir, { recursive: true, force: true })
  await fs.rm(copyDir, { recursive: true, force: true })
  await fs.rm(moveDir, { recursive: true, force: true })
  await fs.mkdir(filingDir, { recursive: true })
  await fs.mkdir(copyDir, { recursive: true })
  await fs.mkdir(moveDir, { recursive: true })

  const fixtureNames = (await fs.readdir(fixtures)).filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
  for (const [index, name] of ['filing-star.jpg', 'filing-two.jpg', 'filing-three.jpg'].entries()) {
    await fs.copyFile(resolve(fixtures, fixtureNames[index]), resolve(filingDir, name))
  }
  await fs.writeFile(resolve(copyDir, 'filing-star.jpg'), 'KEEP-ME')

  log('Launching a new, empty atlas')
  await launch({ profile: emptyProfile })
  await page.waitForSelector('.onboarding__title', { timeout: 30_000 })
  const title = await page.title()
  if (!title.includes('NOEMA Atlas')) throw new Error(`Unexpected window title: ${title}`)
  if ((await page.locator('.image-card').count()) !== 0) throw new Error('An empty atlas should not show images')
  const initial = await page.evaluate(() => window.noema.bootstrap())
  if (initial.stats.images !== 0 || initial.roots.length !== 0) {
    throw new Error('A fresh profile should have no sources or images')
  }
  await screenshot('00-welcome.png')
  await close()

  log('Launching the seeded atlas')
  await launch({ profile: seededProfile, seed: fixtures })
  await waitForScanComplete(28)
  await page.waitForSelector('.image-card', { timeout: 30_000 })
  const cardCount = await page.locator('.image-card').count()
  if (cardCount < 8) throw new Error(`Expected a populated collection, saw ${cardCount} cards`)
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll('.image-card__img')).slice(0, 4)
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
  })
  console.log(`  ${cardCount} cards visible after scan`)

  log('Seeding a curated edit for visual review')
  const seeded = await page.evaluate(async () => {
    const archive = await window.noema.listImages({ scope: 'archive', limit: 16 })
    const ratings = [5, 4, 5, 3, 4, 5, 2, 4, 3, 5]
    const tags = [
      ['amber', 'figure'],
      ['night', 'architecture'],
      ['portrait', 'surreal'],
      ['landscape', 'dream'],
      ['texture', 'warm'],
      ['surreal', 'portrait'],
      ['study', 'light'],
      ['nature', 'surreal'],
      ['blue', 'quiet'],
      ['reference', 'cinematic']
    ]
    for (const [index, item] of archive.items.slice(0, 10).entries()) {
      await window.noema.updateImage({
        id: item.id,
        favorite: index < 6,
        rating: ratings[index] ?? 0,
        tags: tags[index] ?? []
      })
    }
    return (await window.noema.bootstrap()).stats
  })
  if (seeded.favorites !== 6) throw new Error(`Expected 6 favorites, got ${seeded.favorites}`)
  await page.reload()
  await page.waitForSelector('.image-card', { timeout: 30_000 })
  await page.waitForTimeout(900)
  console.log(`  persisted ${seeded.favorites} favorites through a renderer reload`)

  log('Capturing collection')
  await screenshot('01-collection.png')

  log('Opening the image viewer and checking full-size sharpness across navigation')
  await page.locator('.image-card__open').first().click()
  await page.waitForSelector('.lightbox', { timeout: 10_000 })
  await page.waitForFunction(() => {
    const image = document.querySelector('.lightbox__image')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.classList.contains('is-loaded')
  })
  await page.waitForTimeout(600)
  await screenshot('02-viewer.png')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => {
    const image = document.querySelector('.lightbox__image')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.classList.contains('is-loaded')
  })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.lightbox', { state: 'detached' })

  log('Visiting favorites')
  await page.locator('.nav-button', { hasText: 'Favorites' }).click()
  await page.waitForSelector('.page--favorites', { timeout: 10_000 })
  await page.waitForSelector('.image-card', { timeout: 10_000 })
  await screenshot('03-favorites.png')

  log('Creating a moodboard and adding images from its library drawer')
  await page.locator('.nav-button', { hasText: 'Moodboards' }).click()
  await page.waitForSelector('.page--boards')
  await page.getByRole('button', { name: 'New moodboard' }).click()
  await page.locator('.modal-panel input').fill('Amber interiors')
  await page.getByRole('button', { name: 'Create board' }).click()
  await page.waitForSelector('.board-detail-title', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Add from library' }).click()
  await page.waitForSelector('.board-library', { timeout: 10_000 })
  await page.waitForSelector('.board-library__tile', { timeout: 10_000 })
  await page.waitForTimeout(500)

  log('Checking picker thumbnail sizes and filters')
  const pickerSizes = []
  for (const level of [0, 1, 2]) {
    await page.locator('.board-library__status-row .density-control__button').nth(level).click()
    await page.waitForTimeout(250)
    const box = await page.locator('.board-library__tile').first().boundingBox()
    pickerSizes.push(Math.round(box?.width ?? 0))
  }
  if (new Set(pickerSizes).size !== 3) throw new Error(`Picker sizes are not distinct: ${pickerSizes.join(', ')}`)
  await page.locator('.board-library__status-row .density-control__button').nth(1).click()
  await page.waitForTimeout(300)
  const allPickerTiles = await page.locator('.board-library__tile').count()
  await page.getByRole('button', { name: 'Keep', exact: true }).click()
  await page.waitForTimeout(500)
  const keepPickerTiles = await page.locator('.board-library__tile').count()
  if (keepPickerTiles <= 0 || keepPickerTiles >= allPickerTiles) {
    throw new Error(`Picker Keep filter failed (${keepPickerTiles}/${allPickerTiles})`)
  }
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.waitForTimeout(400)
  await page.locator('.board-library__filters select').first().selectOption('5')
  await page.waitForTimeout(500)
  const ratedPickerTiles = await page.locator('.board-library__tile').count()
  if (ratedPickerTiles <= 0) throw new Error('Picker 5-star filter returned no images')
  await page.locator('.board-library__filters select').first().selectOption('0')
  await page.waitForTimeout(400)
  console.log(`  picker sizes ${pickerSizes.join(' / ')} px, Keep ${keepPickerTiles}, 5★ ${ratedPickerTiles}`)
  await dismissToasts()
  await screenshot('04b-picker.png')

  log('Dragging the first library image onto a chosen canvas position')
  const firstTile = page.locator('.board-library__tile').first()
  const canvasBox = await page.locator('.board-canvas').boundingBox()
  if (!canvasBox) throw new Error('Moodboard canvas not visible')
  await dragWithMouse(firstTile, {
    x: canvasBox.x + canvasBox.width * 0.32,
    y: canvasBox.y + canvasBox.height * 0.38
  })
  await page.waitForTimeout(900)
  let board = await getBoard()
  if (!board || board.images.length !== 1) throw new Error(`Library drag created ${board?.images.length ?? 0} items`)
  const dropped = board.images[0]
  if (dropped.x > 0.6 || dropped.y > 0.7) throw new Error('Library drop did not use the drop position')
  console.log(`  library drag placed image at ${dropped.x.toFixed(3)}, ${dropped.y.toFixed(3)}`)

  log('Adding five more images from the drawer')
  for (let index = 0; index < 5; index += 1) {
    const button = page.locator('.board-library__tile:not(.is-included) .board-library__add').first()
    await button.click()
    await page.waitForTimeout(450)
  }
  board = await getBoard()
  if (!board || board.images.length !== 6) throw new Error(`Expected 6 board images, got ${board?.images.length ?? 0}`)
  await page.locator('.board-library__head .icon-button').click()
  await page.waitForTimeout(500)
  await dismissToasts()
  await screenshot('04-moodboard.png')

  log('Free-positioning and resizing a board image, then reloading')
  const itemId = dropped.id
  const beforeLayout = board.images.find((item) => item.id === itemId)
  const boardItem = page.locator(`[data-board-image-id="${itemId}"]`)
  const itemBox = await boardItem.boundingBox()
  if (!itemBox) throw new Error('Board item not visible')
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(140)
  await page.mouse.move(itemBox.x + itemBox.width / 2 + 95, itemBox.y + itemBox.height / 2 + 55, { steps: 18 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(900)
  let moved = (await getBoard()).images.find((item) => item.id === itemId)
  if (
    !moved ||
    (Math.abs(moved.x - beforeLayout.x) < 0.02 && Math.abs(moved.y - beforeLayout.y) < 0.02)
  ) {
    throw new Error('Board image did not move freely')
  }
  console.log(`  moved to ${moved.x.toFixed(3)}, ${moved.y.toFixed(3)}`)

  await boardItem.hover()
  const resizeHandle = boardItem.locator('.board-item__resize')
  const handleBox = await resizeHandle.boundingBox()
  if (!handleBox) throw new Error('Resize handle not visible')
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 55, handleBox.y + handleBox.height / 2 + 35, { steps: 14 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(900)
  const resized = (await getBoard()).images.find((item) => item.id === itemId)
  if (!resized || Math.abs(resized.layoutWidth - moved.layoutWidth) < 0.02) {
    throw new Error('Board image did not resize')
  }
  console.log(`  resized to ${resized.layoutWidth.toFixed(3)} × ${resized.layoutHeight.toFixed(3)}`)

  await page.reload()
  await page.waitForSelector('.board-detail-title', { timeout: 10_000 })
  await page.waitForSelector('.board-item', { timeout: 10_000 })
  const afterReload = (await getBoard()).images.find((item) => item.id === itemId)
  if (
    !afterReload ||
    Math.abs(afterReload.x - resized.x) > 0.005 ||
    Math.abs(afterReload.y - resized.y) > 0.005 ||
    Math.abs(afterReload.layoutWidth - resized.layoutWidth) > 0.005 ||
    Math.abs(afterReload.layoutHeight - resized.layoutHeight) > 0.005
  ) {
    throw new Error('Freeform layout did not persist across a reload')
  }
  console.log('  freeform layout persisted through reload')

  const frameAspect = (afterReload.layoutWidth * 1500) / (afterReload.layoutHeight * 1000)
  const sourceAspect = afterReload.width / afterReload.height
  if (Math.abs(frameAspect / sourceAspect - 1) > 0.02) {
    throw new Error(`Resize did not preserve the source proportion (${frameAspect} vs ${sourceAspect})`)
  }

  log('Testing wheel zoom, panning and Fit All on the unlimited canvas')
  let interactionCanvas = await page.locator('.board-canvas').boundingBox()
  if (!interactionCanvas) throw new Error('Moodboard canvas not visible')
  await page.locator('.board-canvas__controls button').click()
  await page.waitForTimeout(450)
  const zoomBefore = await boardCamera()
  if (!zoomBefore) throw new Error('Board camera missing')
  const zoomPoint = {
    x: interactionCanvas.x + interactionCanvas.width * 0.42,
    y: interactionCanvas.y + interactionCanvas.height * 0.38
  }
  const worldAtCursor = {
    x: (zoomPoint.x - interactionCanvas.x - zoomBefore.x) / zoomBefore.scale,
    y: (zoomPoint.y - interactionCanvas.y - zoomBefore.y) / zoomBefore.scale
  }
  await page.mouse.move(zoomPoint.x, zoomPoint.y)
  await page.mouse.wheel(0, -280)
  await page.waitForTimeout(500)
  const zoomAfter = await boardCamera()
  if (!zoomAfter || zoomAfter.scale <= zoomBefore.scale * 1.04) throw new Error('Mouse wheel did not zoom in')
  const worldAfterZoom = {
    x: (zoomPoint.x - interactionCanvas.x - zoomAfter.x) / zoomAfter.scale,
    y: (zoomPoint.y - interactionCanvas.y - zoomAfter.y) / zoomAfter.scale
  }
  if (
    Math.abs(worldAfterZoom.x - worldAtCursor.x) > 3 ||
    Math.abs(worldAfterZoom.y - worldAtCursor.y) > 3
  ) {
    throw new Error('Wheel zoom was not centered on the cursor')
  }

  await page.locator('.board-canvas__controls button').click()
  await page.waitForTimeout(400)
  const panBefore = await boardCamera()
  await page.keyboard.down('Space')
  await page.waitForTimeout(120)
  await page.mouse.move(interactionCanvas.x + interactionCanvas.width / 2, interactionCanvas.y + interactionCanvas.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    interactionCanvas.x + interactionCanvas.width / 2 + 120,
    interactionCanvas.y + interactionCanvas.height / 2 + 65,
    { steps: 10 }
  )
  await page.mouse.up()
  await page.keyboard.up('Space')
  await page.waitForTimeout(400)
  const panAfter = await boardCamera()
  if (!panBefore || !panAfter || Math.abs(panAfter.x - panBefore.x) < 60) {
    throw new Error('Space-drag did not pan the canvas')
  }

  await page.locator('.board-canvas__controls button').click()
  await page.waitForTimeout(400)
  const middleBefore = await boardCamera()
  await page.mouse.move(interactionCanvas.x + interactionCanvas.width / 2, interactionCanvas.y + interactionCanvas.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(
    interactionCanvas.x + interactionCanvas.width / 2 - 95,
    interactionCanvas.y + interactionCanvas.height / 2 + 40,
    { steps: 10 }
  )
  await page.mouse.up({ button: 'middle' })
  await page.waitForTimeout(400)
  const middleAfter = await boardCamera()
  if (!middleBefore || !middleAfter || Math.abs(middleAfter.x - middleBefore.x) < 50) {
    throw new Error('Middle-mouse drag did not pan the canvas')
  }
  console.log(`  wheel ${zoomBefore.scale.toFixed(2)}→${zoomAfter.scale.toFixed(2)}, space/middle pan verified`)

  await page.locator('.board-canvas__controls button').click()
  await page.waitForTimeout(450)
  const firstVisibleBox = await page.locator('.board-item').first().boundingBox()
  if (!firstVisibleBox) throw new Error('Board item missing before free drag')
  const topId = await page.evaluate(({ x, y }) => {
    const item = document.elementFromPoint(x, y)?.closest('.board-item')
    return item?.getAttribute('data-board-image-id') ?? null
  }, {
    x: firstVisibleBox.x + firstVisibleBox.width / 2,
    y: firstVisibleBox.y + firstVisibleBox.height / 2
  })
  if (!topId) throw new Error('Could not find the top board item')
  const topItem = page.locator(`[data-board-image-id="${topId}"]`)
  const topBox = await topItem.boundingBox()
  if (!topBox) throw new Error('Top board item not visible')
  await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(interactionCanvas.x - 120, interactionCanvas.y + topBox.height / 2, { steps: 18 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  const offCanvas = (await getBoard()).images.find((item) => item.id === topId)
  if (!offCanvas || offCanvas.x >= 0) {
    throw new Error(`Board item did not move beyond the viewport (x=${offCanvas?.x})`)
  }
  await page.locator('.board-canvas__controls button').click()
  await page.waitForTimeout(500)
  const restoredBox = await page.locator(`[data-board-image-id="${topId}"]`).boundingBox()
  if (
    !restoredBox ||
    restoredBox.x < interactionCanvas.x - 2 ||
    restoredBox.x + restoredBox.width > interactionCanvas.x + interactionCanvas.width + 2
  ) {
    throw new Error('Fit All did not recover the off-canvas image')
  }
  console.log(`  image moved off-screen to x=${offCanvas.x.toFixed(2)}, then recovered with Fit All`)

  log('Resetting a distorted legacy image proportion')
  await page.evaluate(async ({ boardId, imageId }) => {
    await window.noema.updateBoardItem({
      moodboardId: boardId,
      imageId,
      x: 0.08,
      y: 0.08,
      width: 0.4,
      height: 0.16,
      z: 30
    })
  }, { boardId: board.id, imageId: itemId })
  await page.reload()
  await page.waitForSelector('.board-detail-title', { timeout: 10_000 })
  await page.waitForSelector('.board-item', { timeout: 10_000 })
  await page.waitForTimeout(500)
  const resetButton = page.locator(`[data-board-image-id="${itemId}"] .board-item__reset`)
  if ((await resetButton.count()) === 0) throw new Error('Reset proportions control is missing')
  await resetButton.click()
  await page.waitForTimeout(800)
  const resetLayout = (await getBoard()).images.find((item) => item.id === itemId)
  if (!resetLayout) throw new Error('Reset image disappeared')
  const resetAspect = (resetLayout.layoutWidth * 1500) / (resetLayout.layoutHeight * 1000)
  if (Math.abs(resetAspect / (resetLayout.width / resetLayout.height) - 1) > 0.02) {
    throw new Error('Reset proportions did not restore the source aspect ratio')
  }
  console.log('  distorted image reset to its original proportion')

  log('Looking at all moodboards')
  await page.locator('.nav-button', { hasText: 'Moodboards' }).click()
  await page.waitForSelector('.board-grid', { timeout: 10_000 })
  await page.waitForFunction(() => {
    const image = document.querySelector('.board-mosaic img')
    return image && image.complete && image.naturalWidth > 0
  })
  await dismissToasts()
  await screenshot('05-moodboards.png')

  log('Testing drag-and-drop from the library onto the moodboard shelf')
  await page.locator('.nav-button', { hasText: /^Collection/ }).click()
  await page.waitForSelector('.image-card')
  const boardBefore = await getBoard()
  const memberIds = new Set(boardBefore.images.map((item) => item.id))
  const cards = page.locator('.image-card')
  const cardTotal = await cards.count()
  let sourceCard = null
  for (let index = 0; index < cardTotal; index += 1) {
    const candidate = cards.nth(index)
    const id = await candidate.getAttribute('data-image-id')
    if (id && !memberIds.has(id)) {
      sourceCard = candidate
      break
    }
  }
  if (!sourceCard) throw new Error('No non-member image available to drag')
  await sourceCard.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  const cardBox = await sourceCard.boundingBox()
  if (!cardBox) throw new Error('Source card is not visible')
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 30, cardBox.y + cardBox.height / 2 + 25, { steps: 8 })
  await page.waitForSelector('.drag-tray', { timeout: 5_000 })
  const shelfTarget = page.locator('.drag-tray__board').filter({ hasText: 'Amber interiors' }).first()
  const shelfBox = await shelfTarget.boundingBox()
  if (!shelfBox) throw new Error('Moodboard shelf target is not visible')
  await page.mouse.move(shelfBox.x + shelfBox.width / 2, shelfBox.y + shelfBox.height / 2, { steps: 18 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(900)
  const boardAfterDrop = await getBoard()
  if (boardAfterDrop.images.length !== boardBefore.images.length + 1) {
    throw new Error(`Library shelf drag failed (${boardBefore.images.length} -> ${boardAfterDrop.images.length})`)
  }
  console.log(`  shelf drag added an image (${boardBefore.images.length} -> ${boardAfterDrop.images.length})`)

  log('Adding a small filing source and curating one image')
  const added = await page.evaluate(async (folder) => {
    return window.noema.addFolders([folder])
  }, filingDir)
  if (!added || added.added.length !== 1) throw new Error('Filing source was not added')
  await waitForScanComplete(31)
  const filing = await page.evaluate(async () => {
    const search = await window.noema.listImages({ scope: 'archive', search: 'filing-star', limit: 5 })
    const item = search.items[0]
    if (!item) throw new Error('Filing image not found after scan')
    await window.noema.updateImage({ id: item.id, favorite: true, rating: 5, tags: ['filing'], reviewed: true })
    const bootstrap = await window.noema.bootstrap()
    const board = bootstrap.moodboards.find((entry) => entry.name === 'Amber interiors')
    if (!board) throw new Error('Board missing while preparing filing image')
    await window.noema.addToMoodboard({ moodboardId: board.id, imageIds: [item.id] })
    return { ...item, boardId: board.id }
  })
  const boardWithFiling = await getBoard()
  if (boardWithFiling.images.length !== 8) throw new Error(`Expected 8 board images, got ${boardWithFiling.images.length}`)
  console.log(`  filing source ready with ${filing.filename}`)

  log('Filing by Keep with copy as the default')
  await page.locator('.nav-button', { hasText: /^Collection/ }).click()
  await page.waitForSelector('.image-card')
  await page.getByRole('button', { name: 'File images' }).click()
  await page.waitForSelector('.organizer', { timeout: 10_000 })
  await page.waitForFunction(() => {
    const heading = document.querySelector('.organizer__selection-head h2')
    return heading?.textContent?.includes('7 images')
  })
  await electronApp.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
  }, copyDir)
  await page.getByRole('button', { name: 'Choose folder' }).click()
  await page.waitForFunction((folder) => {
    return document.querySelector('.organizer__destination-copy')?.textContent?.includes(folder.split(/[\\/]/).pop())
  }, copyDir)
  await dismissToasts()
  await screenshot('09-file-room.png')
  await page.getByRole('button', { name: /Copy 7 images?/ }).click()
  await page.waitForSelector('.organizer-result', { timeout: 30_000 })
  await page.waitForTimeout(600)
  await dismissToasts()
  await screenshot('10-file-result.png')
  const copyResultText = await page.locator('.organizer-result').innerText()
  if (!copyResultText.includes('7 images copied')) throw new Error(`Unexpected copy result: ${copyResultText}`)
  const copiedFiles = (await fs.readdir(copyDir)).sort()
  if (copiedFiles.length !== 8) throw new Error(`Expected 7 copies plus conflict file, saw ${copiedFiles.length}`)
  if (copiedFiles.includes('filing-star.jpg') === false || !copiedFiles.includes('filing-star (1).jpg')) {
    throw new Error(`Conflict rename missing: ${copiedFiles.join(', ')}`)
  }
  if ((await fs.readFile(resolve(copyDir, 'filing-star.jpg'), 'utf8')) !== 'KEEP-ME') {
    throw new Error('Copy overwrote an existing destination file')
  }
  console.log(`  copy produced ${copiedFiles.length - 1} files and protected the conflict`)

  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForSelector('.organizer', { state: 'detached' })

  log('Filing by manual selection with move and confirmation')
  await page.getByRole('button', { name: 'File images' }).click()
  await page.waitForSelector('.organizer')
  await page.getByRole('button', { name: /Manual selection/ }).click()
  await page.locator('.organizer__search input').fill('filing-star')
  await page.waitForSelector(`.organizer-tile[data-image-id="${filing.id}"]`, { timeout: 10_000 })
  await page.locator(`.organizer-tile[data-image-id="${filing.id}"]`).click()
  await page.waitForFunction(() => {
    const heading = document.querySelector('.organizer__selection-head h2')
    return heading?.textContent?.includes('1 image')
  })
  await electronApp.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
  }, moveDir)
  await page.getByRole('button', { name: 'Choose folder' }).click()
  await page.waitForFunction((folder) => {
    return document.querySelector('.organizer__destination-copy')?.textContent?.includes(folder.split(/[\\/]/).pop())
  }, moveDir)
  await page.locator('.organizer__mode-toggle button', { hasText: 'Move' }).click()
  await page.getByRole('button', { name: /Move 1 image/ }).click()
  await page.getByRole('button', { name: 'Yes, move them' }).click()
  await page.waitForSelector('.organizer-result', { timeout: 30_000 })
  const moveResultText = await page.locator('.organizer-result').innerText()
  if (!moveResultText.includes('1 image moved')) throw new Error(`Unexpected move result: ${moveResultText}`)
  const movedPath = resolve(moveDir, 'filing-star.jpg')
  await expectFile(movedPath)
  await expectMissing(resolve(filingDir, 'filing-star.jpg'))
  const movedRecord = await page.evaluate(async (id) => {
    const image = await window.noema.getImage(id)
    const boards = await window.noema.moodboardsForImage(id)
    return { image, boards }
  }, filing.id)
  if (!movedRecord.image || movedRecord.image.path !== movedPath) {
    throw new Error(`Library did not follow the moved file (${movedRecord.image?.path})`)
  }
  if (movedRecord.image.favorite !== true || movedRecord.image.rating !== 5) {
    throw new Error('Move lost favorite or rating metadata')
  }
  if (!movedRecord.boards.includes(filing.boardId)) throw new Error('Move lost the moodboard reference')
  console.log('  move updated the library and preserved the board reference')

  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForSelector('.organizer', { state: 'detached' })

  log('Testing Keep, Pass, Unreviewed and thumbnail controls')
  const expectedCounts = await page.evaluate(async () => {
    const [keep, pass, unreviewed, stars] = await Promise.all([
      window.noema.listImages({ scope: 'archive', decision: 'keep', limit: 1 }),
      window.noema.listImages({ scope: 'archive', decision: 'pass', limit: 1 }),
      window.noema.listImages({ scope: 'archive', unreviewed: true, limit: 1 }),
      window.noema.listImages({ scope: 'archive', minRating: 5, limit: 1 })
    ])
    return { keep: keep.total, pass: pass.total, unreviewed: unreviewed.total, stars: stars.total }
  })
  await page.locator('.nav-button', { hasText: /^Collection/ }).click()
  await page.waitForSelector('.image-card')
  const clickChip = async (label) => {
    await page.locator('.library-toolbar .chip').filter({ hasText: label }).first().click()
    await page.waitForTimeout(700)
  }
  const readCount = async () => {
    const text = await page.locator('.library-toolbar__count').innerText()
    return Number((text.match(/[\d,]+/)?.[0] ?? '0').replace(/,/g, ''))
  }
  await clickChip('Keep')
  if ((await readCount()) !== expectedCounts.keep) throw new Error('Collection Keep filter count is wrong')
  await clickChip('Pass')
  if ((await readCount()) !== expectedCounts.pass) throw new Error('Collection Pass filter count is wrong')
  await clickChip('Unreviewed')
  if ((await readCount()) !== expectedCounts.unreviewed) throw new Error('Collection Unreviewed filter count is wrong')
  await clickChip('Everything')
  await page.locator('.library-toolbar select[aria-label="Minimum star rating"]').selectOption('5')
  await page.waitForTimeout(700)
  if ((await readCount()) !== expectedCounts.stars) throw new Error('Collection star filter count is wrong')
  const librarySizes = []
  for (const level of [0, 1, 2]) {
    await page.locator('.library-toolbar .density-control__button').nth(level).click()
    await page.waitForTimeout(300)
    if ((await page.locator('.image-card').count()) > 0) {
      const box = await page.locator('.image-card').first().boundingBox()
      librarySizes.push(Math.round(box?.width ?? 0))
    }
  }
  if (new Set(librarySizes).size !== 3) throw new Error(`Collection thumbnail sizes not distinct: ${librarySizes}`)
  console.log(`  library filters ${expectedCounts.keep} keep / ${expectedCounts.pass} pass / ${expectedCounts.unreviewed} unreviewed; sizes ${librarySizes.join(' / ')}`)

  await page.locator('.nav-button', { hasText: 'Archive' }).click()
  await page.waitForSelector('.archive-search input')
  await page.locator('.archive-controls select[aria-label="Filter by decision status"]').selectOption('pass')
  await page.waitForTimeout(700)
  const archivePassCount = Number((await page.locator('.archive-result-count strong').innerText()).replace(/,/g, ''))
  if (archivePassCount !== expectedCounts.pass) throw new Error('Archive Pass filter count is wrong')
  await page.locator('.archive-controls select[aria-label="Filter by decision status"]').selectOption('')
  await page.waitForTimeout(600)
  const archiveSizes = []
  for (const level of [0, 1, 2]) {
    await page.locator('.archive-controls .density-control__button').nth(level).click()
    await page.waitForTimeout(300)
    const row = page.locator('.archive-row').first()
    if ((await row.count()) > 0) {
      const box = await row.locator('.archive-row__thumb').boundingBox()
      archiveSizes.push(Math.round(box?.width ?? 0))
    }
  }
  if (new Set(archiveSizes).size !== 3) throw new Error(`Archive thumbnail sizes not distinct: ${archiveSizes}`)
  await page.locator('.archive-controls .density-control__button').nth(1).click()
  console.log(`  archive pass filter ${archivePassCount}; thumbnail sizes ${archiveSizes.join(' / ')}`)

  log('Searching the archive')
  for (let index = 0; index < 5; index += 1) {
    const closeButton = page.locator('.toast__close').first()
    if ((await closeButton.count()) === 0) break
    await closeButton.click().catch(() => undefined)
  }
  await page.locator('.nav-button', { hasText: 'Archive' }).click()
  await page.waitForSelector('.archive-search input')
  await page.locator('.archive-search input').fill('surreal')
  await page.waitForTimeout(800)
  const results = await page.locator('.archive-row').count()
  if (results === 0) throw new Error('Archive search returned no results for "surreal"')
  console.log(`  ${results} archive results for "surreal"`)
  await screenshot('06-archive.png')

  log('Reviewing with sharp full-resolution rendering after Pass')
  await page.locator('.nav-button', { hasText: 'Review Room' }).click()
  await page.waitForSelector('.review-room', { timeout: 15_000 })
  await page.waitForTimeout(600)
  const beforeQueue = await page.evaluate(() => window.noema.bootstrap())
  const firstReviewTitle = await page.locator('.review-panel__title').innerText()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(500)
  await page.keyboard.press('x')
  await page.waitForFunction(() => {
    const full = document.querySelector('.review-image__full')
    const thumb = document.querySelector('.review-image__thumb')
    if (!(full instanceof HTMLImageElement) || !(thumb instanceof HTMLImageElement)) return false
    return (
      full.complete &&
      full.naturalWidth > 0 &&
      full.classList.contains('is-loaded') &&
      Number(getComputedStyle(full).opacity) > 0.9 &&
      Number(getComputedStyle(thumb).opacity) < 0.1 &&
      getComputedStyle(thumb).filter === 'none'
    )
  }, null, { timeout: 15_000 })
  const afterQueue = await page.evaluate(() => window.noema.bootstrap())
  if (afterQueue.stats.unreviewed >= beforeQueue.stats.unreviewed) {
    throw new Error('Pressing Pass did not advance the review queue')
  }
  await dismissToasts()
  console.log('  Pass leaves the next full-size image sharp and visible')
  await screenshot('07-review.png')

  log('Undoing, revisiting and changing an earlier review decision')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(900)
  const undoneQueue = await page.evaluate(() => window.noema.bootstrap())
  const undoneTitle = await page.locator('.review-panel__title').innerText()
  if (undoneQueue.stats.unreviewed !== beforeQueue.stats.unreviewed) {
    throw new Error('Ctrl+Z did not restore the review queue')
  }
  if (undoneTitle !== firstReviewTitle) throw new Error('Undo did not return to the previous image')

  await page.keyboard.press('x')
  await page.waitForTimeout(900)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(600)
  const revisitTitle = await page.locator('.review-panel__title').innerText()
  const earlierState = await page.locator('.review-panel__decided').innerText()
  if (revisitTitle !== firstReviewTitle) throw new Error('Previous navigation did not return to the earlier image')
  if (!earlierState.includes('Passed')) throw new Error('Earlier Pass state was not visible')
  const revisitedId = await page.evaluate(() => {
    const src = document.querySelector('.review-image__full')?.getAttribute('src') ?? ''
    return src.match(/noema:\/\/image\/([a-f0-9]+)/i)?.[1] ?? null
  })
  if (!revisitedId) throw new Error('Could not identify the revisited image')
  await page.locator('.review-action--keep').click()
  await page.waitForTimeout(900)
  const changedRecord = await page.evaluate((id) => window.noema.getImage(id), revisitedId)
  if (!changedRecord || changedRecord.decision !== 'keep' || changedRecord.favorite !== true) {
    throw new Error('Changing an earlier Pass to Keep did not persist')
  }
  console.log('  Ctrl+Z restored the decision; Previous → Keep changed it in place')

  log('Checking the source room')
  await page.locator('.nav-button', { hasText: 'Sources' }).click()
  await page.waitForSelector('.source-row', { timeout: 10_000 })
  await screenshot('08-sources.png')

  log('Verifying session persistence across a full restart')
  const boardBeforeRestart = await getBoard()
  if (!boardBeforeRestart) throw new Error('Board missing before restart')
  const layoutBeforeRestart = boardBeforeRestart.images.find((item) => item.id === filing.id)
  await close()
  await launch({ profile: seededProfile, seed: fixtures })
  await waitForScanComplete(31)
  const persisted = await page.evaluate(() => window.noema.bootstrap())
  if (persisted.stats.favorites < 7) throw new Error(`Favorites did not persist (${persisted.stats.favorites})`)
  if (!persisted.moodboards.some((board) => board.name === 'Amber interiors')) {
    throw new Error('Moodboard did not persist across restart')
  }
  const boardAfterRestart = await getBoard()
  if (!boardAfterRestart) throw new Error('Moodboard missing after restart')
  if (boardAfterRestart.images.length !== 8) {
    throw new Error(`Moodboard contents did not persist (${boardAfterRestart.images.length})`)
  }
  const layoutAfterRestart = boardAfterRestart.images.find((item) => item.id === filing.id)
  if (!layoutAfterRestart || !layoutBeforeRestart) throw new Error('Moved image lost its board placement')
  if (
    Math.abs(layoutAfterRestart.x - layoutBeforeRestart.x) > 0.005 ||
    Math.abs(layoutAfterRestart.layoutWidth - layoutBeforeRestart.layoutWidth) > 0.005
  ) {
    throw new Error('Moved image board layout did not persist')
  }
  const resetAfterRestart = boardAfterRestart.images.find((item) => item.id === itemId)
  if (!resetAfterRestart || Math.abs(resetAfterRestart.layoutHeight - resetLayout.layoutHeight) > 0.005) {
    throw new Error('Reset proportion layout did not persist across restart')
  }
  const movedAfterRestart = await page.evaluate(async (id) => window.noema.getImage(id), filing.id)
  if (!movedAfterRestart || movedAfterRestart.path !== movedPath) {
    throw new Error('Moved image path did not persist across restart')
  }
  console.log(
    `  persisted ${persisted.stats.favorites} favorites, ${persisted.stats.images} images, 8 board placements and the moved path`
  )

  await close()

  if (consoleErrors.length > 0) {
    console.error('\nConsole errors observed:')
    for (const error of consoleErrors) console.error(`  ${error}`)
    throw new Error('The renderer produced console errors')
  }

  console.log('\n✓ NOEMA Atlas E2E checks passed.')
}

async function expectFile(path) {
  const info = await fs.stat(path)
  if (!info.isFile()) throw new Error(`${path} is not a file`)
}

async function expectMissing(path) {
  try {
    await fs.stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${path} still exists after move`)
}

try {
  await main()
} catch (error) {
  console.error('\n✗ E2E failed:', error)
  if (page) {
    await page.screenshot({ path: resolve(screenshotsDir, 'failure.png') }).catch(() => undefined)
  }
  process.exitCode = 1
} finally {
  await close()
}


