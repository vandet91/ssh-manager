const GuacamoleLite = require('guacamole-lite')

const GUACD_HOST = process.env.GUACD_HOST || 'guacd'
const GUACD_PORT = parseInt(process.env.GUACD_PORT || '4822', 10)
const CRYPT_KEY  = process.env.GUAC_CRYPT_KEY || ''
const PORT       = parseInt(process.env.PORT || '3002', 10)

if (!CRYPT_KEY || CRYPT_KEY.length < 16) {
  console.error('ERROR: GUAC_CRYPT_KEY must be set and at least 16 characters')
  process.exit(1)
}

// Pad/trim key to exactly 32 bytes for AES-256
const key = Buffer.alloc(32)
Buffer.from(CRYPT_KEY).copy(key)

const guacServer = new GuacamoleLite(
  { port: PORT },
  {
    host: GUACD_HOST,
    port: GUACD_PORT,
  },
  {
    crypt: {
      cypher: 'AES-256-CBC',
      key: key.toString('latin1'),
    },
    log: {
      level: 'VERBOSE',
    },
    connectionDefaultSettings: {
      rdp: {
        'ignore-cert': 'true',
        'security': 'any',
      },
    },
  },
)

guacServer.on('error', (clientContext, err) => {
  console.error('[guac-proxy] error:', err?.message ?? err)
})

console.log(`Guacamole WebSocket proxy started — port ${PORT} → guacd ${GUACD_HOST}:${GUACD_PORT}`)
