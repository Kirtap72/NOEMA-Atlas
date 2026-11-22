/**
 * Puts text on the clipboard. The modern API is tried first; if the window refuses it (no focus, no permission)
 * an off-screen text field and the classic copy command are used, so copying works everywhere in the app.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the classic way
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  const previous = document.activeElement as HTMLElement | null
  document.body.appendChild(field)
  field.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  field.remove()
  previous?.focus?.()
  return ok
}
