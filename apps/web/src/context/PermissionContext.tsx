import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

const SESSION_KEY = 'ssh-mgr-session'
const SESSION_CHANGE_EVENT = 'ssh-mgr-session-change'

interface PermContext {
  isAdmin: boolean
  loaded: boolean
  reload: () => void
  can: (perm: string) => boolean
}

const Ctx = createContext<PermContext>({
  isAdmin: false, loaded: false,
  reload: () => {}, can: () => false,
})

function readSession(): boolean {
  return localStorage.getItem(SESSION_KEY) === '1'
}

// Call on login; pass null/false on logout
export function setPermissionRole(_role: string | null | undefined) {
  if (_role !== null && _role !== undefined) localStorage.setItem(SESSION_KEY, '1')
  else localStorage.removeItem(SESSION_KEY)
  window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: !!_role }))
}

export function PermissionProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState<boolean>(readSession)

  useEffect(() => {
    const onSameTab = (e: Event) => setLoggedIn(!!(e as CustomEvent).detail)
    const onOtherTab = (e: StorageEvent) => {
      if (e.key === SESSION_KEY) setLoggedIn(readSession())
    }
    window.addEventListener(SESSION_CHANGE_EVENT, onSameTab)
    window.addEventListener('storage', onOtherTab)
    return () => {
      window.removeEventListener(SESSION_CHANGE_EVENT, onSameTab)
      window.removeEventListener('storage', onOtherTab)
    }
  }, [])

  const isAdmin = loggedIn
  const loaded = loggedIn
  const can = (_perm: string) => isAdmin
  const reload = () => setLoggedIn(readSession())

  return <Ctx.Provider value={{ isAdmin, loaded, reload, can }}>{children}</Ctx.Provider>
}

export function usePermissions() { return useContext(Ctx) }
