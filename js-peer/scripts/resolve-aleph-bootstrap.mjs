import { appendFile } from 'node:fs/promises'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'
import { ping } from '@libp2p/ping'
import { webRTCDirect } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

const timeoutMs = Number(process.env.RELAY_BOOTSTRAP_PROBE_TIMEOUT_MS || 10_000)
const override = parseAddressInput(process.env.RELAY_BOOTSTRAP_OVERRIDE)
const fallback = parseAddressInput(process.env.RELAY_BOOTSTRAP_FALLBACK)

function parseAddressInput(value) {
  const raw = value?.trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('Bootstrap address JSON must be an array.')
    return parsed.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

async function probeAddress(address) {
  const node = await createLibp2p({
    transports: [webSockets(), webTransport(), webRTCDirect()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { ping: ping({ timeout: timeoutMs }) },
  })
  const target = multiaddr(address)

  try {
    try {
      const rtt = await node.services.ping.ping(target, { signal: AbortSignal.timeout(timeoutMs) })
      return { address, reachable: true, method: 'ping', detail: `${rtt}ms` }
    } catch (pingError) {
      try {
        const connection = await node.dial(target, { signal: AbortSignal.timeout(timeoutMs) })
        await connection.close()
        return { address, reachable: true, method: 'dial-fallback', detail: formatError(pingError) }
      } catch (dialError) {
        return {
          address,
          reachable: false,
          method: 'failed',
          detail: `ping: ${formatError(pingError)}; dial: ${formatError(dialError)}`,
        }
      }
    }
  } finally {
    await node.stop()
  }
}

// The Aleph bootstrap channel is shared with simple-todo's `orbitdb-relay`;
// scope discovery to our own profile so we never bake in a foreign relay that
// browsers cannot form a shared circuit through.
const profile = process.env.RELAY_BOOTSTRAP_PROFILE?.trim() || 'uc-go-peer'
const discovered =
  override.length > 0
    ? override
    : await discoverAlephBootstrapMultiaddrs({ browserDialableOnly: true, profile })
const candidates = [...new Set([...discovered, ...fallback])]

if (candidates.length === 0) {
  throw new Error('No browser-dialable Aleph bootstrap multiaddresses were discovered.')
}

const results = []
for (const address of candidates) {
  const result = await probeAddress(address)
  results.push(result)
  console.log(`${result.reachable ? '✓' : '✗'} ${address} (${result.method}: ${result.detail})`)
}

const addresses = results.filter((result) => result.reachable).map((result) => result.address)
if (addresses.length === 0) {
  throw new Error(`None of the ${results.length} bootstrap multiaddresses passed ping or dial fallback.`)
}

const serialized = JSON.stringify(addresses)
if (process.env.GITHUB_ENV) {
  await appendFile(process.env.GITHUB_ENV, `NEXT_PUBLIC_RELAY_BOOTSTRAP_MULTIADDRS=${serialized}\n`)
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `json=${serialized}\ncount=${addresses.length}\n`)
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results
    .map(
      (result) => `| \`${result.address}\` | ${result.reachable ? '✅' : '❌'} | ${result.method} | ${result.detail} |`,
    )
    .join('\n')
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## JS-peer bootstrap snapshot\n\n${addresses.length} of ${results.length} addresses embedded in the build.\n\n| Multiaddress | Reachable | Check | Detail |\n| --- | --- | --- | --- |\n${rows}\n`,
  )
}

console.log(`Resolved and verified ${addresses.length} JS-peer bootstrap multiaddress(es).`)
