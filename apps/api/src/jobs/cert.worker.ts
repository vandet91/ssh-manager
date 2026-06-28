import { checkAllCerts, executePendingApplies } from '../modules/cert/cert.service'

const CHECK_INTERVAL_MS  = 24 * 60 * 60 * 1000  // 24 hours
const PENDING_INTERVAL_MS =      5 * 60 * 1000  // 5 minutes

export function startCertWorker(): () => void {
  console.log('Cert worker started — daily checks + pending-apply poll every 5 min')

  // Run full check once at startup (after server settles)
  const startupTimer = setTimeout(() => {
    checkAllCerts().catch((err) => console.error('[cert] Startup check failed:', err))
  }, 30_000)

  // Full daily cert check
  const checkInterval = setInterval(() => {
    checkAllCerts().catch((err) => console.error('[cert] Daily check failed:', err))
  }, CHECK_INTERVAL_MS)

  // Poll for scheduled cert applies every 5 minutes
  const pendingInterval = setInterval(() => {
    executePendingApplies().catch((err) => console.error('[cert] Pending apply poll failed:', err))
  }, PENDING_INTERVAL_MS)

  return () => {
    clearTimeout(startupTimer)
    clearInterval(checkInterval)
    clearInterval(pendingInterval)
  }
}
