/**
 * Poll the app's typed IPC bridge from Node. Playwright's waitForFunction can resolve
 * an async page function incorrectly, so scan state is checked here explicitly.
 */
export async function waitForScanComplete(page, expectedImages, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(async () => window.noema.bootstrap())
    const active = last.scan && ['queued', 'walking', 'processing', 'finalizing'].includes(last.scan.phase)
    if (last.stats.images >= expectedImages && !active) return last
    await page.waitForTimeout(250)
  }
  const state = last
    ? `images=${last.stats.images}, phase=${last.scan?.phase ?? 'idle'}, processed=${last.scan?.processed ?? 0}/${last.scan?.discovered ?? 0}`
    : 'no bootstrap response'
  throw new Error(`Scan did not complete within ${timeoutMs}ms (${state})`)
}
