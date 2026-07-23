import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, EditorContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Transaction, EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import TiptapImage from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import { createLowlight, all } from 'lowlight'
import TurndownService from 'turndown'
import { marked } from 'marked'
import { api, docsApi, Doc, DocType, Server } from '../api/client'

const lowlight = createLowlight(all)

// ── Find & Replace extension ───────────────────────────────────────────────────

const searchKey = new PluginKey<{ term: string; idx: number; matches: { from: number; to: number }[] }>('docSearch')

function buildMatches(doc: Parameters<typeof DecorationSet.create>[0], term: string) {
  const matches: { from: number; to: number }[] = []
  if (!term) return matches
  const lower = term.toLowerCase()
  doc.descendants((node: PmNode, pos: number) => {
    if (!node.isText || !node.text) return
    const text = node.text.toLowerCase()
    let i = text.indexOf(lower)
    while (i !== -1) {
      matches.push({ from: pos + i, to: pos + i + term.length })
      i = text.indexOf(lower, i + 1)
    }
  })
  return matches
}

const SearchExtension = Extension.create({
  name: 'docSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: () => ({ term: '', idx: 0, matches: [] as { from: number; to: number }[] }),
          apply(tr: Transaction, prev: { term: string; idx: number; matches: { from: number; to: number }[] }) {
            const meta = tr.getMeta(searchKey)
            if (meta !== undefined) return meta
            if (tr.docChanged && prev.term) {
              const matches = buildMatches(tr.doc, prev.term)
              return { ...prev, matches, idx: Math.min(prev.idx, Math.max(0, matches.length - 1)) }
            }
            return prev
          },
        },
        props: {
          decorations(state: EditorState) {
            const { term, idx, matches } = searchKey.getState(state)!
            if (!term || !matches.length) return DecorationSet.empty
            const decos = matches.map((m: { from: number; to: number }, i: number) =>
              Decoration.inline(m.from, m.to, {
                style: i === idx
                  ? 'background:#f59e0b;color:#000;border-radius:2px;'
                  : 'background:#fef08a;color:#1a1a1a;border-radius:2px;',
              })
            )
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})

// ── Constants ──────────────────────────────────────────────────────────────────

const DOC_TYPES: { value: DocType; label: string; color: string }[] = [
  { value: 'setup',           label: 'Setup',           color: '#3b82f6' },
  { value: 'configuration',   label: 'Configuration',   color: '#8b5cf6' },
  { value: 'troubleshooting', label: 'Troubleshooting', color: '#ef4444' },
  { value: 'script',          label: 'Script',          color: '#f59e0b' },
  { value: 'runbook',         label: 'Runbook',         color: '#10b981' },
  { value: 'sop',             label: 'SOP',             color: '#06b6d4' },
  { value: 'reference',       label: 'Reference',       color: '#6b7280' },
  { value: 'network',         label: 'Network',         color: '#f97316' },
]

function typeColor(t: string) {
  return DOC_TYPES.find((d) => d.value === t)?.color ?? '#6b7280'
}
function typeLabel(t: string) {
  return DOC_TYPES.find((d) => d.value === t)?.label ?? t
}

// ── Image annotator (Greenshot-style drawing tool) ────────────────────────────

type DrawTool = 'pen' | 'arrow' | 'rect' | 'circle' | 'text' | 'highlight'

interface Shape {
  tool: DrawTool
  color: string
  size: number
  points?: { x: number; y: number }[]
  x1?: number; y1?: number; x2?: number; y2?: number
  text?: string
}

const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ffffff', '#000000']

function drawShapeOnCtx(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  switch (s.tool) {
    case 'pen':
      if (!s.points?.length) return
      ctx.beginPath()
      ctx.moveTo(s.points[0].x, s.points[0].y)
      for (const p of s.points) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      break

    case 'arrow': {
      if (s.x1 === undefined || s.y1 === undefined || s.x2 === undefined || s.y2 === undefined) return
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
      const headLen = s.size * 7 + 16    // medium head
      const wingAngle = Math.PI / 6      // 30° — sharper point
      const shaftW = Math.max(s.size * 2, 3)

      // Wing tips
      const wx1 = s.x2 - headLen * Math.cos(angle - wingAngle)
      const wy1 = s.y2 - headLen * Math.sin(angle - wingAngle)
      const wx2 = s.x2 - headLen * Math.cos(angle + wingAngle)
      const wy2 = s.y2 - headLen * Math.sin(angle + wingAngle)

      // Stop shaft before the head base so it doesn't poke through
      const shaftEndX = s.x2 - headLen * 0.75 * Math.cos(angle)
      const shaftEndY = s.y2 - headLen * 0.75 * Math.sin(angle)

      ctx.lineWidth = shaftW
      ctx.lineCap = 'round'
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(shaftEndX, shaftEndY); ctx.stroke()

      // Filled arrowhead triangle
      ctx.beginPath()
      ctx.moveTo(s.x2, s.y2)
      ctx.lineTo(wx1, wy1)
      ctx.lineTo(wx2, wy2)
      ctx.closePath(); ctx.fill()
      break
    }

    case 'rect':
      if (s.x1 === undefined) return
      ctx.beginPath()
      ctx.strokeRect(s.x1, s.y1!, s.x2! - s.x1, s.y2! - s.y1!)
      break

    case 'circle':
      if (s.x1 === undefined || s.y1 === undefined || s.x2 === undefined || s.y2 === undefined) return
      ctx.beginPath()
      ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2,
        Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      break

    case 'highlight':
      if (s.x1 === undefined) return
      ctx.globalAlpha = 0.35
      ctx.fillRect(s.x1, s.y1!, s.x2! - s.x1, s.y2! - s.y1!)
      ctx.globalAlpha = 1
      break

    case 'text':
      if (!s.text || s.x1 === undefined) return
      ctx.font = `bold ${s.size * 6 + 12}px Arial`
      ctx.fillText(s.text, s.x1, s.y1!)
      break
  }
}

async function uploadAnnotatedBlob(blob: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', new File([blob], 'annotated.png', { type: 'image/png' }))
  const res = await fetch('/api/docs/images', { method: 'POST', credentials: 'include', body: form })
  if (!res.ok) throw new Error('Upload failed')
  const { url } = await res.json() as { url: string }
  return `/api${url}`
}

function ImageAnnotator({ src, onSave, onCancel }: {
  src: string
  onSave: (newSrc: string) => void
  onCancel: () => void
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const imgRef     = useRef<HTMLImageElement | null>(null)
  const drawingRef = useRef(false)
  const currentRef = useRef<Shape | null>(null)
  const shapesRef  = useRef<Shape[]>([])
  const toolRef    = useRef<DrawTool>('arrow')
  const colorRef   = useRef('#ef4444')
  const sizeRef    = useRef(3)

  const [tool, _setTool]   = useState<DrawTool>('arrow')
  const [color, _setColor] = useState('#ef4444')
  const [size, _setSize]   = useState(3)
  const [shapeCount, setShapeCount] = useState(0) // trigger re-render for undo button
  const [imgLoaded, setImgLoaded]   = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState('')

  const setTool  = (v: DrawTool) => { toolRef.current  = v; _setTool(v)  }
  const setColor = (v: string)   => { colorRef.current = v; _setColor(v) }
  const setSize  = (v: number)   => { sizeRef.current  = v; _setSize(v)  }

  const redrawCanvas = useCallback((list: Shape[], cur?: Shape | null) => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    ;[...list, ...(cur ? [cur] : [])].forEach(s => drawShapeOnCtx(ctx, s))
  }, [])

  useEffect(() => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      redrawCanvas([])
      setImgLoaded(true)
    }
    img.onerror = () => setErr('Could not load image for annotation.')
    img.src = src
  }, [src, redrawCanvas])

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!imgRef.current) return
    const pos  = getPos(e)
    const tool = toolRef.current
    if (tool === 'text') {
      const text = window.prompt('Enter annotation text:')
      if (text) {
        const s: Shape = { tool, color: colorRef.current, size: sizeRef.current, x1: pos.x, y1: pos.y, text }
        shapesRef.current = [...shapesRef.current, s]
        setShapeCount(shapesRef.current.length)
        redrawCanvas(shapesRef.current)
      }
      return
    }
    drawingRef.current = true
    currentRef.current = {
      tool, color: colorRef.current, size: sizeRef.current,
      x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y,
      points: tool === 'pen' ? [pos] : undefined,
    }
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentRef.current) return
    const pos = getPos(e)
    const cur = currentRef.current
    currentRef.current = cur.tool === 'pen'
      ? { ...cur, points: [...(cur.points ?? []), pos] }
      : { ...cur, x2: pos.x, y2: pos.y }
    redrawCanvas(shapesRef.current, currentRef.current)
  }

  const onMouseUp = () => {
    if (!drawingRef.current || !currentRef.current) return
    drawingRef.current = false
    shapesRef.current  = [...shapesRef.current, currentRef.current]
    currentRef.current = null
    setShapeCount(shapesRef.current.length)
    redrawCanvas(shapesRef.current)
  }

  const undo = () => {
    shapesRef.current = shapesRef.current.slice(0, -1)
    setShapeCount(shapesRef.current.length)
    redrawCanvas(shapesRef.current)
  }

  const handleSave = async () => {
    if (!canvasRef.current) return
    setSaving(true)
    setErr('')
    try {
      const blob = await new Promise<Blob>((res, rej) =>
        canvasRef.current!.toBlob(b => b ? res(b) : rej(new Error('Canvas export failed')), 'image/png'))
      const newSrc = await uploadAnnotatedBlob(blob)
      onSave(newSrc)
    } catch (e) {
      setErr((e as Error).message)
      setSaving(false)
    }
  }

  const toolDefs: { id: DrawTool; label: string }[] = [
    { id: 'pen',       label: '🖊 Pen'       },
    { id: 'arrow',     label: '→ Arrow'      },
    { id: 'rect',      label: '□ Rect'       },
    { id: 'circle',    label: '○ Circle'     },
    { id: 'text',      label: 'T Text'       },
    { id: 'highlight', label: '▬ Highlight'  },
  ]

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12,
    background: active ? '#3b82f6' : '#2d2d4e',
    color: '#fff', fontWeight: active ? 700 : 400,
  })

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 10000, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{ padding: '8px 14px', background: '#13132b', borderBottom: '1px solid #2d2d4e', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
        {/* Tools */}
        {toolDefs.map(t => (
          <button key={t.id} style={btnStyle(tool === t.id)} onClick={() => setTool(t.id)}>{t.label}</button>
        ))}

        <div style={{ width: 1, height: 24, background: '#2d2d4e', margin: '0 4px' }} />

        {/* Color palette */}
        {PALETTE.map(c => (
          <button key={c} onClick={() => setColor(c)} style={{
            width: 22, height: 22, borderRadius: 4, border: color === c ? '2px solid #fff' : '2px solid transparent',
            background: c, cursor: 'pointer', flexShrink: 0,
          }} />
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#94a3b8' }}>
          <input type="color" value={color} onChange={e => setColor(e.target.value)}
            style={{ width: 22, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
        </label>

        <div style={{ width: 1, height: 24, background: '#2d2d4e', margin: '0 4px' }} />

        {/* Size */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#94a3b8' }}>
          Size
          <select value={size} onChange={e => setSize(Number(e.target.value))} style={{
            background: '#2d2d4e', color: '#e2e8f0', border: '1px solid #3d3d5e', borderRadius: 4, padding: '3px 6px', fontSize: 12,
          }}>
            <option value={1}>Thin</option>
            <option value={3}>Normal</option>
            <option value={6}>Thick</option>
            <option value={12}>Heavy</option>
          </select>
        </label>

        <div style={{ flex: 1 }} />

        {err && <span style={{ fontSize: 12, color: '#f87171' }}>{err}</span>}

        <button onClick={undo} disabled={!shapeCount} style={{ ...btnStyle(false), opacity: shapeCount ? 1 : 0.4 }}>↩ Undo</button>
        <button onClick={handleSave} disabled={saving} style={{ ...btnStyle(false), background: '#16a34a', fontWeight: 700 }}>
          {saving ? 'Saving…' : '✓ Save'}
        </button>
        <button onClick={onCancel} style={{ ...btnStyle(false), background: '#7f1d1d' }}>✕ Cancel</button>
      </div>

      {/* Canvas area */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {!imgLoaded && !err && (
          <span style={{ color: '#94a3b8', fontSize: 14 }}>Loading image…</span>
        )}
        {err && <span style={{ color: '#f87171', fontSize: 14 }}>{err}</span>}
        <canvas
          ref={canvasRef}
          draggable={false}
          onDragStart={e => e.preventDefault()}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          style={{
            maxWidth: '100%', maxHeight: '100%',
            cursor: tool === 'text' ? 'text' : 'crosshair',
            boxShadow: '0 8px 48px rgba(0,0,0,0.6)',
            display: imgLoaded ? 'block' : 'none',
            userSelect: 'none',
          }}
        />
      </div>
    </div>
  )
}

// ── Resizable image node view ─────────────────────────────────────────────────

type ImgAlign = 'left' | 'center' | 'right'

function ResizableImageView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const startX = useRef(0)
  const startW = useRef(0)
  const imgRef = useRef<HTMLImageElement>(null)
  const [showAnnotator, setShowAnnotator] = useState(false)

  const w       = node.attrs.width   as number | null
  const caption = node.attrs.caption as string | null
  const align   = (node.attrs.align  as ImgAlign) || 'left'
  const bordered = node.attrs.bordered as boolean
  const shadowed = node.attrs.shadowed as boolean
  const rounded  = node.attrs.rounded  as boolean

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    startX.current = e.clientX
    startW.current = imgRef.current?.offsetWidth ?? w ?? 400
    const onMove = (ev: MouseEvent) => updateAttributes({ width: Math.max(60, startW.current + ev.clientX - startX.current) })
    const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const wrapStyle: React.CSSProperties = {
    display: 'block',
    maxWidth: '100%',
    marginLeft:  align === 'center' ? 'auto' : align === 'right' ? 'auto' : '0',
    marginRight: align === 'center' ? 'auto' : align === 'right' ? '0'    : 'auto',
    width: w ? `${w}px` : 'fit-content',
  }

  const imgStyle: React.CSSProperties = {
    display: 'block', width: '100%', maxWidth: '100%',
    borderRadius: rounded ? 10 : 4,
    border: bordered ? '2px solid var(--border-med)' : 'none',
    boxShadow: shadowed ? '0 6px 24px rgba(0,0,0,0.4)' : 'none',
    outline: selected ? '2px solid var(--accent-hex)' : 'none',
    outlineOffset: 2,
  }

  const toolbarBtn = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
      style={{
        padding: '2px 7px', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer',
        background: active ? 'var(--accent-hex)' : 'rgba(255,255,255,0.1)',
        color: active ? '#fff' : '#e2e8f0', fontWeight: active ? 700 : 400,
      }}
    >{label}</button>
  )

  return (
    <NodeViewWrapper style={{ display: 'block', userSelect: 'none' }}>
      <div style={wrapStyle}>
        {/* Floating toolbar when selected */}
        {selected && (
          <div contentEditable={false} style={{
            display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap',
            background: 'rgba(15,15,25,0.92)', borderRadius: 7, padding: '5px 8px',
            marginBottom: 6, width: 'max-content', maxWidth: '100%',
          }}>
            {/* Align */}
            {(['left','center','right'] as ImgAlign[]).map((a) =>
              toolbarBtn({ left: '⬅', center: '⬆', right: '➡' }[a], align === a, () => updateAttributes({ align: a }))
            )}
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
            {/* Style toggles */}
            {toolbarBtn('Border',  bordered, () => updateAttributes({ bordered: !bordered }))}
            {toolbarBtn('Shadow',  shadowed, () => updateAttributes({ shadowed: !shadowed }))}
            {toolbarBtn('Rounded', rounded,  () => updateAttributes({ rounded:  !rounded  }))}
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
            {/* Size presets */}
            {[25, 50, 75, 100].map((pct) =>
              toolbarBtn(`${pct}%`, false, () => {
                const parent = imgRef.current?.closest('.tiptap') as HTMLElement | null
                const containerW = parent?.offsetWidth ?? 600
                updateAttributes({ width: Math.round(containerW * pct / 100) })
              })
            )}
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
            {/* Width badge */}
            {w && <span style={{ fontSize: 10, color: '#94a3b8' }}>{w}px</span>}
            <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />
            {/* Annotate */}
            {toolbarBtn('✏ Draw', false, () => setShowAnnotator(true))}
            {/* Delete */}
            {toolbarBtn('🗑 Delete', false, () => {
              if (window.confirm('Delete this image?')) deleteNode()
            })}
          </div>
        )}

        {/* Image annotator modal — rendered via portal to escape contentEditable */}
        {showAnnotator && createPortal(
          <ImageAnnotator
            src={node.attrs.src as string}
            onSave={(newSrc) => { updateAttributes({ src: newSrc }); setShowAnnotator(false) }}
            onCancel={() => setShowAnnotator(false)}
          />,
          document.body
        )}

        {/* Image */}
        <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
          <img ref={imgRef} src={node.attrs.src as string} alt={caption ?? ''} style={imgStyle} />
          {/* Resize handle */}
          {selected && (
            <div onMouseDown={onMouseDown} style={{
              position: 'absolute', bottom: 6, right: 6,
              width: 14, height: 14, background: 'var(--accent-hex)',
              borderRadius: 3, cursor: 'nwse-resize',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 7L7 1M4 7L7 4" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </div>
          )}
        </div>

        {/* Caption */}
        {(selected || caption) && (
          <div contentEditable={selected} suppressContentEditableWarning
            onBlur={(e) => updateAttributes({ caption: e.currentTarget.textContent ?? '' })}
            style={{
              fontSize: 12, color: 'var(--text-muted)', textAlign: 'center',
              padding: '4px 6px', marginTop: 4, borderRadius: 4, outline: 'none',
              background: selected ? 'var(--bg-input)' : 'transparent',
              minHeight: 20, fontStyle: 'italic',
            }}
          >
            {caption || (selected ? '' : undefined)}
            {!caption && selected && <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>Add caption…</span>}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  )
}

const ResizableImage = TiptapImage.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width:    { default: null },
      caption:  { default: null },
      align:    { default: 'left' },
      bordered: { default: false },
      shadowed: { default: false },
      rounded:  { default: true  },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView)
  },
})

// ── Toolbar button ─────────────────────────────────────────────────────────────

function Btn({ title, active, disabled, onClick, children }: {
  title: string; active?: boolean; disabled?: boolean
  onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      style={{
        padding: '3px 7px', borderRadius: 5, border: 'none', cursor: disabled ? 'default' : 'pointer',
        fontSize: 12, fontWeight: 600, lineHeight: 1,
        background: active ? 'var(--accent-hex)' : 'var(--bg-input)',
        color: active ? '#fff' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span style={{ width: 1, height: 18, background: 'var(--border-med)', margin: '0 2px', flexShrink: 0 }} />
}

// ── Text color picker ────────────────────────────────────────────────────────
// A curated 4-shade ramp (dark → light) across the hue wheel, plus grayscale.
const TEXT_COLOR_SWATCHES = [
  '#7f1d1d', '#991b1b', '#dc2626', '#ef4444', '#f87171', '#fca5a5',
  '#9a3412', '#c2410c', '#ea580c', '#f97316', '#fb923c', '#fdba74',
  '#854d0e', '#a16207', '#ca8a04', '#eab308', '#facc15', '#fde047',
  '#14532d', '#166534', '#16a34a', '#22c55e', '#4ade80', '#86efac',
  '#134e4a', '#0f766e', '#0d9488', '#14b8a6', '#2dd4bf', '#5eead4',
  '#1e3a8a', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd',
  '#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd',
  '#831843', '#be185d', '#db2777', '#ec4899', '#f472b6', '#f9a8d4',
  '#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
]
const HEX_RE = /^#[0-9a-fA-F]{6}$/
const RECENT_COLORS_KEY = 'doc.recentTextColors'

function TextColorPicker({ editor }: { editor: ReturnType<typeof useEditor> }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [hex, setHex] = useState('#ef4444')
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? '[]') } catch { return [] }
  })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const currentColor = editor?.getAttributes('textStyle').color as string | undefined

  // Anchor the popover to the button, clamped so it never runs off-screen —
  // this is what was broken before: the old native color input was hidden
  // (display:none), so browsers had no real box to anchor the dialog to and
  // fell back to opening it at the top-left of the screen instead of near
  // the toolbar button that triggered it.
  const openPicker = () => {
    const r = btnRef.current?.getBoundingClientRect()
    const POP_W = 268, POP_H = 340
    if (r) {
      let left = r.left
      let top = r.bottom + 6
      if (left + POP_W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - POP_W - 8)
      if (top + POP_H > window.innerHeight - 8) top = Math.max(8, r.top - POP_H - 6)
      setPos({ top, left })
    }
    setHex(HEX_RE.test(currentColor ?? '') ? currentColor! : '#ef4444')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onScrollOrResize = () => setOpen(false)
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  const apply = (color: string) => {
    editor?.chain().focus().setColor(color).run()
    setRecent((prev) => {
      const next = [color, ...prev.filter((c) => c !== color)].slice(0, 12)
      try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    setOpen(false)
  }

  const clear = () => { editor?.chain().focus().unsetColor().run(); setOpen(false) }

  const swatchBtn = (c: string, size: number) => (
    <button
      key={c} title={c} onMouseDown={(e) => { e.preventDefault(); apply(c) }}
      style={{
        width: size, height: size, borderRadius: 5, cursor: 'pointer', padding: 0,
        background: c,
        border: currentColor === c ? '2px solid var(--accent-hex)' : '1px solid rgba(127,127,127,0.35)',
        boxShadow: currentColor === c ? '0 0 0 2px rgba(var(--accent)/0.25)' : 'none',
      }}
    />
  )

  return (
    <>
      <button
        ref={btnRef} type="button" title="Text color"
        onMouseDown={(e) => { e.preventDefault(); open ? setOpen(false) : openPicker() }}
        style={{
          padding: '3px 6px', borderRadius: 5, border: 'none', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, lineHeight: 1, display: 'flex', alignItems: 'center', gap: 4,
          background: open ? 'var(--accent-hex)' : 'var(--bg-input)',
          color: open ? '#fff' : 'var(--text-secondary)',
        }}
      >
        🎨
        <span style={{
          width: 12, height: 12, borderRadius: 3, display: 'inline-block',
          background: currentColor ?? 'transparent',
          border: `1px solid ${currentColor ? 'rgba(0,0,0,0.25)' : 'var(--border-med)'}`,
        }} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: 268, zIndex: 10001,
            background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)', padding: 12,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
            Text Color
          </div>

          {/* Swatch ramp */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 5, marginBottom: 10 }}>
            {TEXT_COLOR_SWATCHES.map((c) => swatchBtn(c, 26))}
          </div>

          {/* Recently used */}
          {recent.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>Recent</div>
              <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
                {recent.map((c) => swatchBtn(c, 20))}
              </div>
            </>
          )}

          {/* Hex input + full-spectrum picker */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <input
              type="color" value={HEX_RE.test(hex) ? hex : '#ef4444'} onChange={(e) => setHex(e.target.value)}
              title="Full-spectrum picker"
              style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}
            />
            <input
              value={hex} onChange={(e) => setHex(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && HEX_RE.test(hex)) apply(hex) }}
              placeholder="#rrggbb"
              style={{
                flex: 1, padding: '5px 8px', borderRadius: 5, fontSize: 12, fontFamily: 'monospace',
                border: `1px solid ${HEX_RE.test(hex) ? 'var(--border-med)' : 'var(--danger)'}`,
                background: 'var(--bg-input)', color: 'var(--text-primary)',
              }}
            />
            <button
              onMouseDown={(e) => { e.preventDefault(); if (HEX_RE.test(hex)) apply(hex) }}
              disabled={!HEX_RE.test(hex)}
              style={{
                padding: '5px 10px', borderRadius: 5, border: 'none', cursor: HEX_RE.test(hex) ? 'pointer' : 'default',
                background: 'var(--accent-hex)', color: '#fff', fontSize: 11, fontWeight: 600,
                opacity: HEX_RE.test(hex) ? 1 : 0.5,
              }}
            >
              Apply
            </button>
          </div>

          <button
            onMouseDown={(e) => { e.preventDefault(); clear() }}
            style={{
              width: '100%', padding: '6px 0', borderRadius: 5, border: '1px solid var(--border-med)',
              background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
            }}
          >
            ✕ Remove color
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Documentation() {
  const [docs, setDocs] = useState<Doc[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('Untitled')
  const [docType, setDocType] = useState<DocType>('reference')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [serverId, setServerId] = useState<string>('')
  const [isPinned, setIsPinned] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [showFind, setShowFind]   = useState(false)
  const [findTerm, setFindTerm]   = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [findCount, setFindCount] = useState(0)
  const [findIdx, setFindIdx]     = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const imageRef  = useRef<HTMLInputElement>(null)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  // Block browser tab close / refresh when dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Block in-app navigation (BrowserRouter uses history.pushState)
  useEffect(() => {
    if (!dirty) return
    const orig = history.pushState.bind(history)
    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      if (window.confirm('You have unsaved changes. Leave without saving?')) {
        history.pushState = orig
        orig(...args)
      }
    }
    return () => { history.pushState = orig }
  }, [dirty])

  // ── Find helpers ─────────────────────────────────────────────────────────────

  // ── Load list ────────────────────────────────────────────────────────────────

  const loadDocs = useCallback(async () => {
    const rows = await docsApi.list({
      search: search || undefined,
      doc_type: typeFilter !== 'all' ? typeFilter : undefined,
    }).catch(() => [] as Doc[])
    setDocs(rows)
  }, [search, typeFilter])

  useEffect(() => { loadDocs() }, [loadDocs])

  useEffect(() => {
    api.get<Server[]>('/servers').then((s) => setServers(s.filter((sv) => sv.os_type !== 'windows'))).catch(() => {})
  }, [])

  // ── Editor setup ──────────────────────────────────────────────────────────────

  const uploadImageFile = useCallback(async (file: File): Promise<string> => {
    const result = await docsApi.uploadImage(file)
    return `/api${result.url}`
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      SearchExtension,
      Underline,
      TextStyle,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false, HTMLAttributes: { target: '_blank', rel: 'noopener' } }),
      ResizableImage.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockLowlight.configure({ lowlight }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing your document…' }),
    ],
    content: '',
    onUpdate: () => setDirty(true),
    editorProps: {
      handlePaste(_view: unknown, event: ClipboardEvent) {
        const items = event.clipboardData?.items
        if (!items) return false
        for (const item of Array.from(items) as DataTransferItem[]) {
          if (item.type.startsWith('image/')) {
            event.preventDefault()
            const file = item.getAsFile()
            if (!file) return true
            uploadImageFile(file).then((url) => {
              editor?.chain().focus().setImage({ src: url }).run()
            }).catch(() => showToast('Image upload failed', false))
            return true
          }
        }
        return false
      },
    },
  })

  // ── Find helpers (after editor is declared) ───────────────────────────────────

  const applySearch = useCallback((term: string, newIdx?: number) => {
    if (!editor) return
    const matches = buildMatches(editor.state.doc, term)
    const idx = newIdx !== undefined ? newIdx : 0
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { term, idx, matches }))
    setFindCount(matches.length)
    setFindIdx(idx)
  }, [editor])

  const findNext = useCallback(() => {
    if (!editor) return
    const st = searchKey.getState(editor.state)!
    if (!st.matches.length) return
    const next = (st.idx + 1) % st.matches.length
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { ...st, idx: next }))
    setFindIdx(next)
    editor.commands.setTextSelection({ from: st.matches[next].from, to: st.matches[next].to })
  }, [editor])

  const findPrev = useCallback(() => {
    if (!editor) return
    const st = searchKey.getState(editor.state)!
    if (!st.matches.length) return
    const prev = (st.idx - 1 + st.matches.length) % st.matches.length
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { ...st, idx: prev }))
    setFindIdx(prev)
    editor.commands.setTextSelection({ from: st.matches[prev].from, to: st.matches[prev].to })
  }, [editor])

  const clearSearch = useCallback(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { term: '', idx: 0, matches: [] }))
    setFindTerm(''); setFindCount(0); setFindIdx(0); setShowFind(false)
  }, [editor])

  const replaceOne = useCallback(() => {
    if (!editor) return
    const st = searchKey.getState(editor.state)!
    if (!st.matches.length) return
    const m = st.matches[st.idx]
    editor.chain().focus().setTextSelection({ from: m.from, to: m.to }).insertContent(replaceTerm).run()
    applySearch(findTerm)
  }, [editor, replaceTerm, findTerm, applySearch])

  const replaceAll = useCallback(() => {
    if (!editor) return
    const st = searchKey.getState(editor.state)!
    if (!st.matches.length) return
    const chain = editor.chain().focus()
    ;[...st.matches].reverse().forEach((m) => {
      chain.setTextSelection({ from: m.from, to: m.to }).insertContent(replaceTerm)
    })
    chain.run()
    applySearch(findTerm)
    showToast(`Replaced ${st.matches.length} occurrence${st.matches.length !== 1 ? 's' : ''}`)
  }, [editor, replaceTerm, findTerm, applySearch])

  // Ctrl+F / Cmd+F to open find bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && selectedId) {
        e.preventDefault()
        setShowFind(true)
        setTimeout(() => findInputRef.current?.focus(), 50)
      }
      if (e.key === 'Escape' && showFind) clearSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, showFind, clearSearch])

  // ── Select a doc ─────────────────────────────────────────────────────────────

  const selectDoc = async (id: string) => {
    if (dirty && selectedId) {
      if (!window.confirm('You have unsaved changes. Discard and open another document?')) return
    }
    const doc = await docsApi.get(id).catch(() => null)
    if (!doc) return
    setSelectedId(id)
    setTitle(doc.title)
    setDocType(doc.doc_type as DocType)
    setTags((doc.tags as string[]) ?? [])
    setServerId(doc.server_id ?? '')
    setIsPinned(doc.is_pinned)
    editor?.commands.setContent(doc.content ?? '')
    setDirty(false)
  }

  // ── New document ──────────────────────────────────────────────────────────────

  const newDoc = async () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    const created = await docsApi.create({ title: 'Untitled', doc_type: 'reference', tags: [], content: '', is_pinned: false })
    await loadDocs()
    setSelectedId(created.id)
    setTitle('Untitled')
    setDocType('reference')
    setTags([])
    setServerId('')
    setIsPinned(false)
    editor?.commands.setContent('')
    setDirty(false)
    setTimeout(() => document.getElementById('doc-title-input')?.focus(), 100)
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  const save = async () => {
    if (!selectedId) return
    setSaving(true)
    try {
      await docsApi.update(selectedId, {
        title, doc_type: docType, tags,
        content: editor?.getHTML() ?? '',
        server_id: serverId || null,
        is_pinned: isPinned,
      })
      setDirty(false)
      await loadDocs()
      showToast('Saved')
    } catch {
      showToast('Save failed', false)
    } finally {
      setSaving(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  const deleteDoc = async () => {
    if (!selectedId) return
    if (!window.confirm('Delete this document? This cannot be undone.')) return
    await docsApi.remove(selectedId)
    setSelectedId(null)
    editor?.commands.setContent('')
    setDirty(false)
    await loadDocs()
    showToast('Document deleted')
  }

  // ── Tags ─────────────────────────────────────────────────────────────────────

  const addTag = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      const t = tagInput.trim().toLowerCase().replace(/,/g, '')
      if (t && !tags.includes(t)) { setTags([...tags, t]); setDirty(true) }
      setTagInput('')
    }
  }
  const removeTag = (t: string) => { setTags(tags.filter((x) => x !== t)); setDirty(true) }

  // ── Import ────────────────────────────────────────────────────────────────────

  // Map file extension → highlight.js language name
  const CODE_LANG: Record<string, string> = {
    sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    py: 'python', pyw: 'python',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript',
    sql: 'sql',
    yaml: 'yaml', yml: 'yaml',
    json: 'json',
    xml: 'xml',
    conf: 'nginx', cfg: 'ini', ini: 'ini',
    dockerfile: 'dockerfile',
    tf: 'hcl', hcl: 'hcl',
    rb: 'ruby',
    php: 'php',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    c: 'c', h: 'c',
    txt: 'plaintext', log: 'plaintext',
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImporting(true)
    try {
      let html = ''
      let guessType: DocType = 'reference'
      const name = file.name.toLowerCase()
      const ext = name.split('.').pop() ?? ''

      if (name.endsWith('.docx')) {
        const res = await docsApi.importDocx(file)
        html = res.html
      } else if (name.endsWith('.pdf')) {
        const res = await docsApi.importPdf(file)
        html = res.html
      } else if (name.endsWith('.md')) {
        const text = await file.text()
        html = await marked(text) as string
      } else if (name.endsWith('.html') || name.endsWith('.htm')) {
        html = await file.text()
      } else if (ext in CODE_LANG) {
        // Code / script file — wrap in a code block
        const text = await file.text()
        const lang = CODE_LANG[ext]
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        html = `<pre data-language="${lang}"><code class="language-${lang}">${escaped}</code></pre>`
        guessType = ['sh', 'bash', 'zsh', 'ksh', 'ps1', 'psm1', 'py', 'rb', 'php'].includes(ext) ? 'script' : 'reference'
      } else {
        // Fallback: try to read as plain text
        try {
          const text = await file.text()
          const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          html = `<pre data-language="plaintext"><code>${escaped}</code></pre>`
        } catch {
          showToast('Unsupported file format', false)
          return
        }
      }

      editor?.commands.setContent(html)
      const docTitle = file.name.replace(/\.[^.]+$/, '')
      if (!selectedId) {
        const created = await docsApi.create({
          title: docTitle, doc_type: guessType, tags: [ext].filter(Boolean),
          content: html, is_pinned: false,
        })
        setSelectedId(created.id)
        setTitle(created.title)
        setDocType(guessType)
        setTags(created.tags as string[])
        setIsPinned(false)
        await loadDocs()
      } else {
        setTitle(docTitle)
        setDocType(guessType)
      }
      setDirty(true)
      showToast(`Imported ${file.name}`)
    } catch {
      showToast('Import failed', false)
    } finally {
      setImporting(false)
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────────

  // Shared CSS for all exports — covers TipTap's table/task/code markup
  const EXPORT_CSS = `
    body { font-family: Arial, sans-serif; padding: 40px; max-width: 960px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 28px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin: 0 0 24px; }
    h2 { font-size: 22px; margin: 22px 0 10px; }
    h3 { font-size: 17px; margin: 18px 0 8px; }
    p  { margin: 0 0 10px; }
    pre { background: #f4f4f5; border-radius: 6px; padding: 14px 16px; overflow-x: auto; margin: 10px 0; }
    code { font-family: 'Courier New', monospace; font-size: 13px; background: #f4f4f5; padding: 1px 4px; border-radius: 3px; }
    pre code { background: none; padding: 0; }
    /* Table — match both TipTap schema and plain <table> */
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    table[data-type="table"] { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td, .tableHeader, .tableCell { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; vertical-align: top; }
    th, .tableHeader { background: #f3f4f6; font-weight: 600; }
    tr:nth-child(even) td { background: #fafafa; }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    blockquote { border-left: 4px solid #9ca3af; margin: 10px 0; padding: 4px 16px; color: #6b7280; background: #f9fafb; }
    a { color: #2563eb; }
    ul, ol { padding-left: 22px; margin: 0 0 10px; }
    ul[data-type="taskList"] { list-style: none; padding-left: 0; }
    ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; margin: 3px 0; }
    ul[data-type="taskList"] li input { margin-top: 3px; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
  `

  // Get clean serialized HTML from TipTap editor DOM (includes tables properly)
  const getExportHtml = () => {
    // Use the editor's serialized HTML — TipTap's getHTML() serializes all nodes including tables
    return editor?.getHTML() ?? ''
  }

  const exportPdf = () => {
    const content = getExportHtml()
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>${EXPORT_CSS}
        @media print { body { padding: 20px; } }
      </style>
    </head><body><h1>${title}</h1>${content}</body></html>`)
    win.document.close()
    setTimeout(() => win.print(), 500)
  }

  const exportHtml = () => {
    const content = getExportHtml()
    const html = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${EXPORT_CSS}</style>
</head><body>
  <h1>${title}</h1>
  ${content}
</body></html>`
    const blob = new Blob([html], { type: 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${title.replace(/[^a-z0-9]/gi, '_')}.html`
    a.click()
  }

  const exportMarkdown = () => {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

    // Table support — TurndownService doesn't handle tables by default
    td.addRule('table', {
      filter: 'table',
      replacement: (_content: string, node: HTMLElement) => {
        const rows = Array.from((node as Element).querySelectorAll('tr'))
        if (!rows.length) return ''
        const lines: string[] = []
        rows.forEach((row, rowIdx) => {
          const cells = Array.from(row.querySelectorAll('th, td'))
          const line = '| ' + cells.map((c) => (c.textContent ?? '').replace(/\n/g, ' ').trim()).join(' | ') + ' |'
          lines.push(line)
          // After header row, add separator
          if (rowIdx === 0) {
            lines.push('| ' + cells.map(() => '---').join(' | ') + ' |')
          }
        })
        return '\n\n' + lines.join('\n') + '\n\n'
      },
    })
    // Suppress individual th/td rules so the table rule handles everything
    td.addRule('tableCell', { filter: ['th', 'td'], replacement: (c: string) => c })
    td.addRule('tableRow',  { filter: 'tr',          replacement: (c: string) => c })

    // Task list checkboxes
    td.addRule('taskItem', {
      filter: (node: HTMLElement) => node.nodeName === 'LI' && node.closest('ul[data-type="taskList"]') !== null,
      replacement: (_content: string, node: HTMLElement) => {
        const checked = (node as Element).querySelector('input[type="checkbox"]')?.hasAttribute('checked')
        const text = (node.textContent ?? '').trim()
        return `\n- [${checked ? 'x' : ' '}] ${text}`
      },
    })

    const md = td.turndown(getExportHtml())
    const blob = new Blob([md], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${title.replace(/[^a-z0-9]/gi, '_')}.md`
    a.click()
  }

  // ── Image toolbar button ──────────────────────────────────────────────────────

  const insertImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const url = await uploadImageFile(file)
      editor?.chain().focus().setImage({ src: url }).run()
    } catch {
      showToast('Image upload failed', false)
    }
  }

  // ── Sidebar filtered docs ─────────────────────────────────────────────────────

  const pinned  = docs.filter((d) => d.is_pinned)
  const unpinned = docs.filter((d) => !d.is_pinned)

  const typeCounts = DOC_TYPES.map((t) => ({
    ...t,
    count: docs.filter((d) => d.doc_type === t.value).length,
  }))

  // ── Styles ────────────────────────────────────────────────────────────────────

  const sidebarStyle: React.CSSProperties = {
    width: 240, flexShrink: 0, borderRight: '1px solid var(--border-weak)',
    display: 'flex', flexDirection: 'column', overflowY: 'auto',
    background: 'var(--bg-sidebar)',
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 48px)', overflow: 'hidden' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: toast.ok ? '#065f46' : '#7f1d1d',
          border: `1px solid ${toast.ok ? '#047857' : '#991b1b'}`,
          borderRadius: 8, padding: '10px 20px',
          color: toast.ok ? '#6ee7b7' : '#fca5a5',
          fontSize: 13, fontWeight: 500, zIndex: 9999,
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Hidden inputs */}
      <input ref={importRef} type="file" style={{ display: 'none' }}
        accept=".docx,.pdf,.md,.html,.htm,.sh,.bash,.zsh,.ps1,.psm1,.psd1,.py,.js,.ts,.sql,.yaml,.yml,.json,.xml,.conf,.cfg,.ini,.tf,.hcl,.rb,.php,.go,.rs,.java,.cs,.cpp,.c,.h,.txt,.log,.dockerfile"
        onChange={handleImport} />
      <input ref={imageRef} type="file" style={{ display: 'none' }}
        accept="image/*" onChange={insertImage} />

      {/* ── Sidebar ── */}
      <div style={sidebarStyle}>
        {/* Search */}
        <div style={{ padding: '12px 10px 8px' }}>
          <input
            type="text" placeholder="🔍 Search docs…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6,
              border: '1px solid var(--border-med)', background: 'var(--bg-input)',
              color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box',
            }}
          />
        </div>

        {/* New doc button */}
        <div style={{ padding: '0 10px 10px' }}>
          <button onClick={newDoc} style={{
            width: '100%', padding: '7px', borderRadius: 6, border: 'none',
            background: 'var(--accent-hex)', color: '#fff', fontWeight: 600,
            fontSize: 12, cursor: 'pointer',
          }}>
            + New Document
          </button>
        </div>

        {/* Type filters */}
        <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button onClick={() => setTypeFilter('all')} style={{
            textAlign: 'left', background: typeFilter === 'all' ? 'var(--accent-hex)20' : 'none',
            border: 'none', borderRadius: 5, padding: '4px 8px',
            color: typeFilter === 'all' ? 'var(--accent-hex)' : 'var(--text-secondary)',
            fontSize: 12, cursor: 'pointer', fontWeight: typeFilter === 'all' ? 700 : 400,
          }}>
            All ({docs.length})
          </button>
          {typeCounts.map((t) => (
            <button key={t.value} onClick={() => setTypeFilter(t.value)} style={{
              textAlign: 'left', background: typeFilter === t.value ? `${t.color}20` : 'none',
              border: 'none', borderRadius: 5, padding: '4px 8px',
              color: typeFilter === t.value ? t.color : 'var(--text-secondary)',
              fontSize: 12, cursor: 'pointer', fontWeight: typeFilter === t.value ? 700 : 400,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
              {t.label} {t.count > 0 && <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>{t.count}</span>}
            </button>
          ))}
        </div>

        <div style={{ height: 1, background: 'var(--border-weak)', margin: '0 10px 8px' }} />

        {/* Pinned */}
        {pinned.length > 0 && (
          <>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 14px 4px', margin: 0 }}>
              📌 Pinned
            </p>
            {pinned.map((d) => <DocRow key={d.id} doc={d} selected={selectedId === d.id} onClick={() => selectDoc(d.id)} />)}
            <div style={{ height: 1, background: 'var(--border-weak)', margin: '6px 10px' }} />
          </>
        )}

        {/* Doc list */}
        {unpinned.length > 0 && (
          <>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 14px 4px', margin: 0 }}>
              Documents
            </p>
            {unpinned.map((d) => <DocRow key={d.id} doc={d} selected={selectedId === d.id} onClick={() => selectDoc(d.id)} />)}
          </>
        )}

        {docs.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 16 }}>
            No documents yet.
          </p>
        )}
      </div>

      {/* ── Editor area ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-body)' }}>
        {!selectedId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Select a document or create a new one.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={newDoc} style={{
                padding: '8px 18px', borderRadius: 7, border: 'none',
                background: 'var(--accent-hex)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}>+ New Document</button>
              <button onClick={() => importRef.current?.click()} style={{
                padding: '8px 18px', borderRadius: 7, border: '1px solid var(--border-med)',
                background: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
              }}>↑ Import File</button>
            </div>
          </div>
        ) : (
          <>
            {/* Meta bar */}
            <div style={{
              padding: '10px 20px', borderBottom: '1px solid var(--border-weak)',
              display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0,
              background: 'var(--bg-card)',
            }}>
              {/* Title row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="doc-title-input"
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); setDirty(true) }}
                  style={{
                    flex: 1, fontSize: 20, fontWeight: 700, background: 'none', border: 'none',
                    color: 'var(--text-heading)', outline: 'none', padding: 0,
                  }}
                  placeholder="Document title"
                />
                <button
                  onClick={() => { setIsPinned(!isPinned); setDirty(true) }}
                  title={isPinned ? 'Unpin' : 'Pin'}
                  style={{
                    background: isPinned ? '#f59e0b20' : 'none', border: 'none',
                    borderRadius: 5, padding: '3px 7px', cursor: 'pointer', fontSize: 14,
                    color: isPinned ? '#f59e0b' : 'var(--text-muted)',
                  }}
                >📌</button>
                <button
                  onClick={() => {
                    if (dirty && !window.confirm('You have unsaved changes. Close without saving?')) return
                    setSelectedId(null)
                    editor?.commands.setContent('')
                    setDirty(false)
                  }}
                  title="Close document"
                  style={{
                    background: 'none', border: 'none', borderRadius: 5,
                    padding: '3px 7px', cursor: 'pointer', fontSize: 16,
                    color: 'var(--text-muted)', lineHeight: 1,
                  }}
                >×</button>
              </div>

              {/* Type + server + tags row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {/* Type */}
                <select value={docType} onChange={(e) => { setDocType(e.target.value as DocType); setDirty(true) }}
                  style={{
                    padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)',
                    background: `${typeColor(docType)}20`, color: typeColor(docType),
                    fontWeight: 600, fontSize: 12, cursor: 'pointer',
                  }}>
                  {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>

                {/* Server */}
                <select value={serverId} onChange={(e) => { setServerId(e.target.value); setDirty(true) }}
                  style={{
                    padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)',
                    background: 'var(--bg-input)', color: 'var(--text-secondary)',
                    fontSize: 12, cursor: 'pointer',
                  }}>
                  <option value="">No server</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>

                {/* Tags */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  {tags.map((t) => (
                    <span key={t} style={{
                      fontSize: 11, padding: '2px 7px', borderRadius: 10,
                      background: 'var(--bg-input)', color: 'var(--text-secondary)',
                      border: '1px solid var(--border-med)', display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      {t}
                      <button onClick={() => removeTag(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, fontSize: 11 }}>×</button>
                    </span>
                  ))}
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={addTag}
                    placeholder="Add tag…"
                    style={{
                      fontSize: 11, padding: '2px 6px', borderRadius: 5,
                      border: '1px dashed var(--border-med)', background: 'none',
                      color: 'var(--text-secondary)', width: 80, outline: 'none',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Toolbar */}
            <div style={{
              padding: '6px 12px', borderBottom: '1px solid var(--border-weak)',
              display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap',
              background: 'var(--bg-card)', flexShrink: 0,
            }}>
              <Btn title="Bold" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>B</Btn>
              <Btn title="Italic" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></Btn>
              <Btn title="Underline" active={editor?.isActive('underline')} onClick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></Btn>
              <Btn title="Strikethrough" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}>S̶</Btn>
              <Sep />
              <Btn title="Heading 1" active={editor?.isActive('heading', { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>H1</Btn>
              <Btn title="Heading 2" active={editor?.isActive('heading', { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Btn>
              <Btn title="Heading 3" active={editor?.isActive('heading', { level: 3 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Btn>
              <Sep />
              <Btn title="Bullet list" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>•</Btn>
              <Btn title="Numbered list" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1.</Btn>
              <Btn title="Task list" active={editor?.isActive('taskList')} onClick={() => editor?.chain().focus().toggleTaskList().run()}>✓</Btn>
              <Sep />
              <Btn title="Inline code" active={editor?.isActive('code')} onClick={() => editor?.chain().focus().toggleCode().run()}>{`<>`}</Btn>
              <Btn title="Code block" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>{`\`\`\``}</Btn>
              <Btn title="Blockquote" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>❝</Btn>
              <Btn title="Horizontal rule" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>—</Btn>
              <Sep />
              <Btn title="Insert table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>⊞</Btn>
              {editor?.isActive('table') && (<>
                <Sep />
                <Btn title="Add column before" onClick={() => editor.chain().focus().addColumnBefore().run()}>+←col</Btn>
                <Btn title="Add column after"  onClick={() => editor.chain().focus().addColumnAfter().run()}>+col→</Btn>
                <Btn title="Delete column"     onClick={() => editor.chain().focus().deleteColumn().run()}>✕col</Btn>
                <Sep />
                <Btn title="Add row above" onClick={() => editor.chain().focus().addRowBefore().run()}>+↑row</Btn>
                <Btn title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}>+row↓</Btn>
                <Btn title="Delete row"    onClick={() => editor.chain().focus().deleteRow().run()}>✕row</Btn>
                <Sep />
                <Btn title="Delete entire table" onClick={() => { if (window.confirm('Delete this table?')) editor.chain().focus().deleteTable().run() }}>🗑 table</Btn>
              </>)}
              <Sep />
              <Btn title="Align left"   active={editor?.isActive({ textAlign: 'left' })}    onClick={() => editor?.chain().focus().setTextAlign('left').run()}>⬅</Btn>
              <Btn title="Align center" active={editor?.isActive({ textAlign: 'center' })}  onClick={() => editor?.chain().focus().setTextAlign('center').run()}>⬆</Btn>
              <Btn title="Align right"  active={editor?.isActive({ textAlign: 'right' })}   onClick={() => editor?.chain().focus().setTextAlign('right').run()}>➡</Btn>
              <Sep />
              <Btn title="Insert link" active={editor?.isActive('link')} onClick={() => {
                const url = window.prompt('Enter URL:', editor?.getAttributes('link').href ?? 'https://')
                if (url === null) return
                if (url === '') { editor?.chain().focus().unsetLink().run(); return }
                editor?.chain().focus().setLink({ href: url }).run()
              }}>🔗</Btn>
              <Btn title="Insert image" onClick={() => imageRef.current?.click()}>🖼</Btn>
              <TextColorPicker editor={editor} />
              <Sep />
              <Btn title="Find & Replace (Ctrl+F)" active={showFind} onClick={() => {
                setShowFind(!showFind)
                if (!showFind) setTimeout(() => findInputRef.current?.focus(), 50)
                else clearSearch()
              }}>🔍</Btn>
            </div>

            {/* Find & Replace bar */}
            {showFind && (
              <div style={{
                padding: '7px 14px', borderBottom: '1px solid var(--border-weak)',
                background: 'var(--bg-card)', display: 'flex', alignItems: 'center',
                gap: 6, flexShrink: 0, flexWrap: 'wrap',
              }}>
                {/* Find input */}
                <input
                  ref={findInputRef}
                  value={findTerm}
                  onChange={(e) => { setFindTerm(e.target.value); applySearch(e.target.value) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.shiftKey ? findPrev() : findNext() }
                    if (e.key === 'Escape') clearSearch()
                  }}
                  placeholder="Find…"
                  style={{
                    padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border-med)',
                    background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12,
                    width: 180, outline: 'none',
                    boxShadow: findTerm && findCount === 0 ? '0 0 0 1px #ef4444' : undefined,
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 60 }}>
                  {findTerm ? (findCount === 0 ? 'No matches' : `${findIdx + 1} / ${findCount}`) : ''}
                </span>
                <button onMouseDown={(e) => { e.preventDefault(); findPrev() }}
                  title="Previous (Shift+Enter)" disabled={findCount === 0}
                  style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
                  ↑
                </button>
                <button onMouseDown={(e) => { e.preventDefault(); findNext() }}
                  title="Next (Enter)" disabled={findCount === 0}
                  style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
                  ↓
                </button>
                <span style={{ width: 1, height: 18, background: 'var(--border-med)', margin: '0 2px' }} />
                {/* Replace input */}
                <input
                  value={replaceTerm}
                  onChange={(e) => setReplaceTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') replaceOne() }}
                  placeholder="Replace with…"
                  style={{
                    padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border-med)',
                    background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12,
                    width: 160, outline: 'none',
                  }}
                />
                <button onMouseDown={(e) => { e.preventDefault(); replaceOne() }}
                  disabled={findCount === 0}
                  style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
                  Replace
                </button>
                <button onMouseDown={(e) => { e.preventDefault(); replaceAll() }}
                  disabled={findCount === 0}
                  style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
                  Replace All
                </button>
                <button onMouseDown={(e) => { e.preventDefault(); clearSearch() }}
                  title="Close (Esc)"
                  style={{ marginLeft: 'auto', padding: '3px 8px', borderRadius: 5, border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>
                  ×
                </button>
              </div>
            )}

            {/* Editor content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 32px' }}>
              <style>{`
                .tiptap { outline: none; min-height: 400px; color: var(--text-primary); font-size: 14px; line-height: 1.7; }
                .tiptap p { margin: 0 0 10px; }
                .tiptap h1 { font-size: 26px; font-weight: 700; margin: 24px 0 10px; color: var(--text-heading); }
                .tiptap h2 { font-size: 20px; font-weight: 700; margin: 20px 0 8px; color: var(--text-heading); }
                .tiptap h3 { font-size: 16px; font-weight: 700; margin: 16px 0 6px; color: var(--text-heading); }
                .tiptap ul, .tiptap ol { padding-left: 22px; margin: 0 0 10px; }
                .tiptap li { margin: 2px 0; }
                .tiptap code { background: var(--bg-input); padding: 2px 5px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #f59e0b; }
                .tiptap pre { background: #0d0d14; border-radius: 8px; padding: 14px 16px; overflow-x: auto; margin: 10px 0; }
                .tiptap pre code { background: none; color: #e2e8f0; padding: 0; font-size: 13px; }
                .tiptap blockquote { border-left: 3px solid var(--accent-hex); margin: 10px 0; padding-left: 14px; color: var(--text-secondary); }
                .tiptap hr { border: none; border-top: 1px solid var(--border-med); margin: 16px 0; }
                .tiptap table { border-collapse: collapse; width: 100%; margin: 10px 0; }
                .tiptap th, .tiptap td { border: 1px solid var(--border-med); padding: 8px 12px; text-align: left; }
                .tiptap th { background: var(--bg-input); font-weight: 600; color: var(--text-heading); }
                .tiptap img { max-width: 100%; height: auto; border-radius: 6px; margin: 8px 0; }
                .tiptap a { color: var(--accent-hex); text-decoration: underline; }
                .tiptap ul[data-type="taskList"] { list-style: none; padding-left: 0; }
                .tiptap ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
                .tiptap ul[data-type="taskList"] li > label { margin-top: 2px; }
                .tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--text-muted); pointer-events: none; float: left; height: 0; }
                .tiptap .selectedCell { background: var(--accent-hex)20; }
              `}</style>
              <EditorContent editor={editor} className="tiptap" />
            </div>

            {/* Action bar */}
            <div style={{
              padding: '8px 20px', borderTop: '1px solid var(--border-weak)',
              display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
              background: 'var(--bg-card)',
            }}>
              {/* Import dropdown */}
              <div style={{ position: 'relative' }}>
                <button
                  disabled={importing}
                  onClick={() => importRef.current?.click()}
                  style={{
                    padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-med)',
                    background: 'var(--bg-input)', color: 'var(--text-secondary)',
                    fontSize: 12, cursor: 'pointer', fontWeight: 500,
                  }}>
                  {importing ? '⏳ Importing…' : '↑ Import'}
                </button>
              </div>

              {/* Export */}
              <ExportMenu onPdf={exportPdf} onHtml={exportHtml} onMd={exportMarkdown} />

              <div style={{ flex: 1 }} />

              {dirty && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Unsaved changes</span>}

              <button onClick={deleteDoc} style={{
                padding: '6px 14px', borderRadius: 6, border: '1px solid #7f1d1d',
                background: 'none', color: '#ef4444', fontSize: 12, cursor: 'pointer',
              }}>Delete</button>

              <button onClick={save} disabled={saving || !dirty} style={{
                padding: '6px 18px', borderRadius: 6, border: 'none',
                background: (saving || !dirty) ? 'var(--bg-input)' : 'var(--accent-hex)',
                color: (saving || !dirty) ? 'var(--text-muted)' : '#fff',
                fontSize: 12, fontWeight: 600, cursor: (saving || !dirty) ? 'default' : 'pointer',
              }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Doc row in sidebar ─────────────────────────────────────────────────────────

function DocRow({ doc, selected, onClick }: { doc: Doc; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left', background: selected ? 'var(--accent-hex)15' : 'none',
      border: 'none', borderLeft: selected ? '3px solid var(--accent-hex)' : '3px solid transparent',
      padding: '7px 10px 7px 11px', cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', background: typeColor(doc.doc_type), flexShrink: 0,
        }} />
        <span style={{
          fontSize: 12, fontWeight: selected ? 600 : 400,
          color: selected ? 'var(--text-heading)' : 'var(--text-secondary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>{doc.title}</span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, paddingLeft: 13 }}>
        {typeLabel(doc.doc_type)} · {new Date(doc.updated_at).toLocaleDateString()}
      </div>
    </button>
  )
}

// ── Export menu ────────────────────────────────────────────────────────────────

function ExportMenu({ onPdf, onHtml, onMd }: { onPdf: () => void; onHtml: () => void; onMd: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(!open)} style={{
        padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-med)',
        background: 'var(--bg-input)', color: 'var(--text-secondary)',
        fontSize: 12, cursor: 'pointer', fontWeight: 500,
      }}>↓ Export ▾</button>
      {open && (
        <div style={{
          position: 'absolute', bottom: '110%', left: 0, background: 'var(--bg-card)',
          border: '1px solid var(--border-med)', borderRadius: 8, overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)', minWidth: 140, zIndex: 100,
        }}>
          {[
            { label: '📄 PDF (Print)', action: onPdf },
            { label: '🌐 HTML file', action: onHtml },
            { label: '📝 Markdown', action: onMd },
          ].map((item) => (
            <button key={item.label} onClick={() => { item.action(); setOpen(false) }} style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '9px 14px', border: 'none', background: 'none',
              color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-input)')}
            onMouseOut={(e)  => (e.currentTarget.style.background = 'none')}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
