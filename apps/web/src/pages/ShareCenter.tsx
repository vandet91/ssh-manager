import { useEffect, useState } from 'react'
import { api } from '../api/client'

type ShareItem = {
  id: string
  type: 'text' | 'file'
  name: string
  size?: number
  content?: string
  createdAt: string
  expiresAt: string
}

export default function ShareCenter() {
  const [items, setItems] = useState<ShareItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadItems()
    const interval = setInterval(loadItems, 5000) // Refresh every 5s
    return () => clearInterval(interval)
  }, [])

  const loadItems = async () => {
    try {
      const res = await api.get<ShareItem[]>('/share/list')
      setItems(res)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  const downloadFile = (id: string, name: string) => {
    const link = document.createElement('a')
    link.href = `/api/share/access/${id}`
    link.download = name
    link.click()
  }

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const saveAsFile = (text: string, filename: string = 'sticky-note.txt') => {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  const textItems = items.filter(x => x.type === 'text')
  const fileItems = items.filter(x => x.type === 'file')

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: '40px 20px',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 32, fontWeight: 700, color: '#fff', textAlign: 'center' }}>
          🔗 Share Center
        </h1>
        <p style={{ margin: '0 0 40px', fontSize: 16, color: 'rgba(255,255,255,0.9)', textAlign: 'center' }}>
          {loading ? 'Loading...' : `${items.length} shared item${items.length !== 1 ? 's' : ''}`}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
          {/* Sticky Notes */}
          {textItems.map(item => (
            <div
              key={item.id}
              style={{
                background: '#fff9e6',
                border: '2px solid #f0e68c',
                borderRadius: 12,
                padding: 20,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                position: 'relative',
                minHeight: 200,
              }}
            >
              <div style={{
                fontSize: 40,
                marginBottom: 12,
                opacity: 0.3,
              }}>
                📋
              </div>
              <p style={{
                margin: 0,
                fontSize: 14,
                color: '#333',
                lineHeight: 1.6,
                maxHeight: 120,
                overflow: 'auto',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
              }}>
                {item.content}
              </p>
              <div style={{ marginTop: 16, display: 'flex', gap: 8, flexDirection: 'column' }}>
                <button
                  onClick={() => copyText(item.content || '')}
                  style={{
                    padding: '10px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#f0e68c',
                    color: '#333',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  📋 Copy Text
                </button>
                <button
                  onClick={() => saveAsFile(item.content || '', 'command.txt')}
                  style={{
                    padding: '10px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#e8f5e9',
                    color: '#2e7d32',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  💾 Save as File
                </button>
              </div>
            </div>
          ))}

          {/* Files */}
          {fileItems.map(item => (
            <div
              key={item.id}
              style={{
                background: '#fff',
                border: '2px solid #e0e0e0',
                borderRadius: 12,
                padding: 20,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{
                fontSize: 40,
                marginBottom: 12,
              }}>
                📄
              </div>
              <h3 style={{
                margin: '0 0 8px',
                fontSize: 16,
                fontWeight: 600,
                color: '#333',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {item.name}
              </h3>
              <p style={{
                margin: '0 0 16px',
                fontSize: 13,
                color: '#999',
              }}>
                {item.size ? `${(item.size / 1024).toFixed(1)} KB` : 'File'}
              </p>
              <button
                onClick={() => downloadFile(item.id, item.name)}
                style={{
                  padding: '10px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#667eea',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                ⬇ Download
              </button>
            </div>
          ))}
        </div>

        {items.length === 0 && !loading && (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.8)', fontSize: 16, marginTop: 60 }}>
            <p style={{ fontSize: 48, marginBottom: 16 }}>📭</p>
            <p>No shared items yet</p>
          </div>
        )}

        <p style={{
          margin: '60px 0 0',
          fontSize: 12,
          color: 'rgba(255,255,255,0.6)',
          textAlign: 'center',
        }}>
          Share Center • Files and text expire after 24 hours
        </p>
      </div>
    </div>
  )
}
