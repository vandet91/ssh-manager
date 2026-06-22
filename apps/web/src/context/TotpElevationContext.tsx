import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import TotpModal from '../components/TotpModal'

interface PendingAction {
  action: string
  resolve: () => void
  reject: (err: Error) => void
}

interface TotpElevationContextType {
  requestElevation: (action: string) => Promise<void>
  isElevated: boolean
  elevatedUntil: number | null
  markElevated: (until: number) => void
}

const TotpElevationContext = createContext<TotpElevationContextType>({
  requestElevation: async () => {},
  isElevated: false,
  elevatedUntil: null,
  markElevated: () => {},
})

export function TotpElevationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [elevatedUntil, setElevatedUntil] = useState<number | null>(null)

  const isElevated = elevatedUntil !== null && elevatedUntil > Date.now()

  const markElevated = useCallback((until: number) => {
    setElevatedUntil(until)
  }, [])

  // Call this before any critical action. Resolves immediately if already elevated,
  // otherwise shows the TOTP modal and waits for the user to verify.
  const requestElevation = useCallback((action: string): Promise<void> => {
    if (elevatedUntil && elevatedUntil > Date.now()) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      setPending({ action, resolve, reject })
    })
  }, [elevatedUntil])

  const handleSuccess = useCallback(() => {
    // Fetch new elevation status from server, then resolve
    import('../api/client').then(({ api }) =>
      api.get('/auth/totp/elevation-status').then((res: any) => {
        if (res.data.elevated) setElevatedUntil(res.data.elevatedUntil)
        pending?.resolve()
        setPending(null)
      })
    ).catch(() => { pending?.reject(new Error('Elevation failed')); setPending(null) })
  }, [pending])

  const handleCancel = useCallback(() => {
    pending?.reject(new Error('TOTP cancelled'))
    setPending(null)
  }, [pending])

  return (
    <TotpElevationContext.Provider value={{ requestElevation, isElevated, elevatedUntil, markElevated }}>
      {children}
      {pending && (
        <TotpModal
          action={pending.action}
          onSuccess={handleSuccess}
          onCancel={handleCancel}
        />
      )}
    </TotpElevationContext.Provider>
  )
}

export function useTotpElevation() {
  return useContext(TotpElevationContext)
}
