import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

interface SystemNameCtx { systemName: string; setSystemName: (n: string) => void }
const Ctx = createContext<SystemNameCtx>({ systemName: 'SSH Manager', setSystemName: () => {} })

const CACHE_KEY = 'ssh-mgr-system-name'

export function SystemNameProvider({ children }: { children: ReactNode }) {
  const [systemName, setSystemNameState] = useState(() => localStorage.getItem(CACHE_KEY) ?? 'SSH Manager')

  useEffect(() => {
    fetch('/api/settings/public')
      .then(r => r.json())
      .then((d: { system_name: string }) => {
        if (d.system_name) {
          setSystemNameState(d.system_name)
          localStorage.setItem(CACHE_KEY, d.system_name)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => { document.title = systemName }, [systemName])

  function setSystemName(n: string) {
    setSystemNameState(n)
    localStorage.setItem(CACHE_KEY, n)
    document.title = n
  }

  return <Ctx.Provider value={{ systemName, setSystemName }}>{children}</Ctx.Provider>
}

export function useSystemName() { return useContext(Ctx) }
