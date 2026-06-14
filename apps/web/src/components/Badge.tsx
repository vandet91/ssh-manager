interface Props { label: string; variant?: 'ok' | 'low' | 'medium' | 'high' | 'critical' | 'default' }

// Uses explicit color values so badges stay readable across all themes
const styles: Record<string, { bg: string; color: string; border: string }> = {
  ok:       { bg: 'rgba(115,191,105,0.15)', color: '#73bf69', border: 'rgba(115,191,105,0.35)' },
  low:      { bg: 'rgba(255,152,48,0.15)',  color: '#ff9830', border: 'rgba(255,152,48,0.35)' },
  medium:   { bg: 'rgba(255,152,48,0.2)',   color: '#ffb357', border: 'rgba(255,152,48,0.45)' },
  high:     { bg: 'rgba(242,73,92,0.15)',   color: '#f2495c', border: 'rgba(242,73,92,0.35)' },
  critical: { bg: 'rgba(242,73,92,0.25)',   color: '#ff6b7a', border: 'rgba(242,73,92,0.6)' },
  default:  { bg: 'rgba(159,167,179,0.1)',  color: '#9fa7b3', border: 'rgba(159,167,179,0.2)' },
}

export default function Badge({ label, variant = 'default' }: Props) {
  const s = styles[variant] ?? styles.default
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: '0.7rem',
      fontWeight: 500,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      background: s.bg,
      color: s.color,
      border: `1px solid ${s.border}`,
    }}>
      {label}
    </span>
  )
}
