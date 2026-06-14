import { ReactNode, useEffect, useRef } from 'react'

type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

const MAX_WIDTHS: Record<ModalSize, number> = {
  sm:  420,
  md:  540,
  lg:  760,
  xl: 1000,
}

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  size?: ModalSize
}

export default function Modal({ title, onClose, children, size = 'md' }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Close on backdrop click
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(3px)',
      }}
    >
      <div style={{
        width: '100%',
        maxWidth: MAX_WIDTHS[size],
        maxHeight: 'calc(100vh - 32px)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--modal-bg)',
        border: '1px solid var(--modal-border)',
        borderRadius: 10,
        boxShadow: '0 8px 40px rgba(0,0,0,0.55)',
        overflow: 'hidden',
      }}>
        {/* Header — fixed, never scrolls */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '13px 20px',
          background: 'var(--card-header-bg)',
          borderBottom: '1px solid var(--modal-border)',
          flexShrink: 0,
        }}>
          <h2 style={{
            margin: 0, fontSize: 14, fontWeight: 600,
            color: 'var(--text-heading)', letterSpacing: '0.01em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            paddingRight: 12,
          }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            style={{
              flexShrink: 0,
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '3px 7px', fontSize: 15, lineHeight: 1,
              color: 'var(--text-muted)', borderRadius: 4,
              transition: 'color 0.1s, background 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--border-weak)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'none' }}
          >
            ✕
          </button>
        </div>

        {/* Body — scrolls independently */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '20px',
          minHeight: 0,
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}
