import { useEffect, useState } from 'react'
import type { ProvenanceInfo } from '@shared/studio'
import { openStudio } from './Studio'

const WAY: Record<string, string> = { blend: 'Atlas Blend', comfyui: 'ComfyUI', openai: 'OpenAI', external: 'another program' }

/** Where a made or edited picture came from: its moodboard, the pictures it was built from, and its series. */
export function Provenance({ imageId, onOpen }: { imageId: string; onOpen: (imageId: string) => void }): React.JSX.Element | null {
  const [info, setInfo] = useState<ProvenanceInfo | null>(null)
  useEffect(() => {
    let alive = true
    setInfo(null)
    void window.noema.studioProvenance(imageId).then((value) => alive && setInfo(value)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [imageId])
  if (!info) return null
  const { record, sources, series } = info
  const verb = record.kind === 'generation' ? 'Made' : record.kind === 'edit' ? 'Edited' : record.kind === 'upscale' ? 'Enlarged' : 'Edited elsewhere'
  return (
    <div className="inspector__section provenance" data-testid="provenance">
      <div className="inspector__section-title">Where this came from</div>
      <p>
        {verb} with {WAY[record.methodId] ?? record.methodId}
        {record.moodboardName ? <> from the moodboard “{record.moodboardName}”</> : null}.
      </p>
      {record.prompt ? <p className="provenance__prompt">“{record.prompt}”</p> : null}
      {sources.length ? (
        <div className="provenance__sources">
          {sources.map((s) => (
            <figure key={s.id} title={`${s.filename}${s.roles.length ? ` · ${s.roles.join(', ')}` : ''}`}>
              <img src={s.thumbUrl} alt="" draggable={false} />
              {s.roles.length ? <figcaption>{s.roles[0]}</figcaption> : null}
            </figure>
          ))}
        </div>
      ) : null}
      {series.length > 1 ? (
        <div className="provenance__series">
          <span>Series · {series.length} pictures</span>
          {series.map((r) => (
            <button key={r.id} type="button" className={r.id === record.id ? 'is-on' : ''} onClick={() => r.imageId && onOpen(r.imageId)} disabled={!r.imageId}>
              {r.kind === 'generation' ? (r.parentId ? 'variation' : 'first') : r.kind}
            </button>
          ))}
        </div>
      ) : null}
      {record.moodboardId ? (
        <button type="button" className="button button--ghost" onClick={() => openStudio({ mode: 'create', boardId: record.moodboardId!, prompt: record.prompt, negative: record.negative, roles: record.roles, title: record.title })}>
          Make another from this
        </button>
      ) : null}
    </div>
  )
}
