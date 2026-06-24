import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { api } from '../api/client'

interface PermissionContextValue {
  permissions: string[]
  role: string
  can: (permission: string) => boolean
  isAdmin: boolean
  reload: () => void
}

const PermissionContext = createContext<PermissionContextValue>({
  permissions: [],
  role: '',
  can: () => false,
  isAdmin: false,
  reload: () => {},
})

export function PermissionProvider({ children }: { children: ReactNode }) {
  const [permissions, setPermissions] = useState<string[]>([])
  const [role, setRole] = useState('')

  const load = useCallback(() => {
    api.get<{ role: string; permissions: string[] }>('/auth/me/permissions')
      .then((r) => { setPermissions(r.permissions); setRole(r.role) })
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const isAdmin = role === 'admin'
  const can = (permission: string) => isAdmin || permissions.includes('*') || permissions.includes(permission)

  return (
    <PermissionContext.Provider value={{ permissions, role, can, isAdmin, reload: load }}>
      {children}
    </PermissionContext.Provider>
  )
}

export function usePermissions() {
  return useContext(PermissionContext)
}
