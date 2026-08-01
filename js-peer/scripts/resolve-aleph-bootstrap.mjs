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
// Addresses used purely to prove the relay is alive. They are never embedded in
// the build: the browser cannot dial raw tcp, and the proxy-wss address is
// already part of the discovered set once the Aleph registration is visible.
const liveness = parseAddressInput(process.env.RELAY_BOOTSTRAP_LIVENESS)

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

// WebTransport and WebRTC-Direct are browser-only from this process: Node ships
// no WebTransport client API, and dialing webrtc-direct from Node fails during
// the handshake even with a working node-datachannel binding. Probing them here
// rejects exactly the addresses the browser needs most, so we prove the peer is
// live over a Node-dialable address and carry the browser families through on
// that proof.
function classifyAddress(address) {
  const names = multiaddr(address).protoNames()
  if (names.includes('webtransport')) return 'webtransport'
  if (names.includes('webrtc-direct')) return 'webrtc-direct'
  if (names.includes('ws') || names.includes('wss')) return 'websocket'
  if (names.includes('tcp')) return 'tcp'
  return 'unknown'
}

const BROWSER_ONLY_FAMILIES = new Set(['webtransport', 'webrtc-direct'])
const NODE_DIALABLE_FAMILIES = new Set(['websocket'])

function peerIdOf(address) {
  try {
    return multiaddr(address).getPeerId()
  } catch {
    return null
  }
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
  override.length > 0 ? override : await discoverAlephBootstrapMultiaddrs({ browserDialableOnly: true, profile })
const candidates = [...new Set([...discovered, ...fallback])]

if (candidates.length === 0) {
  throw new Error('No browser-dialable Aleph bootstrap multiaddresses were discovered.')
}

// Probe every Node-dialable address we know of, including the liveness-only
// ones, so a peer whose candidate set is browser-only can still be proven live.
const probeTargets = [...new Set([...candidates, ...liveness])].filter((address) =>
  NODE_DIALABLE_FAMILIES.has(classifyAddress(address)),
)

const probeResults = new Map()
const livePeers = new Set()
for (const address of probeTargets) {
  const result = await probeAddress(address)
  probeResults.set(address, result)
  if (result.reachable) {
    const peerId = peerIdOf(address)
    if (peerId) livePeers.add(peerId)
  }
  console.log(`${result.reachable ? '✓' : '✗'} ${address} (${result.method}: ${result.detail})`)
}

const results = candidates.map((address) => {
  const family = classifyAddress(address)
  const probed = probeResults.get(address)
  if (probed) return { ...probed, family }

  if (BROWSER_ONLY_FAMILIES.has(family)) {
    const peerId = peerIdOf(address)
    if (peerId == null) {
      return { address, family, reachable: false, method: 'rejected', detail: 'no /p2p component' }
    }
    if (!address.includes('/certhash/')) {
      return { address, family, reachable: false, method: 'rejected', detail: 'no /certhash component' }
    }
    if (!livePeers.has(peerId)) {
      return {
        address,
        family,
        reachable: false,
        method: 'unverified',
        detail: 'no Node-dialable address proved this peer is live',
      }
    }
    return { address, family, reachable: true, method: 'peer-verified', detail: `${peerId} verified over websocket` }
  }

  return { address, family, reachable: false, method: 'skipped', detail: `unsupported family: ${family}` }
})

for (const result of results) {
  if (probeResults.has(result.address)) continue
  console.log(`${result.reachable ? '✓' : '✗'} ${result.address} (${result.method}: ${result.detail})`)
}

const addresses = results.filter((result) => result.reachable).map((result) => result.address)
if (addresses.length === 0) {
  throw new Error(
    `None of the ${results.length} bootstrap multiaddresses could be verified (no live peer over a Node-dialable address).`,
  )
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
      (result) =>
        `| \`${result.address}\` | ${result.family} | ${result.reachable ? '✅' : '❌'} | ${result.method} | ${result.detail} |`,
    )
    .join('\n')
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## JS-peer bootstrap snapshot\n\n${addresses.length} of ${results.length} addresses embedded in the build.\n\n| Multiaddress | Family | Embedded | Check | Detail |\n| --- | --- | --- | --- | --- |\n${rows}\n`,
  )
}

console.log(`Resolved and verified ${addresses.length} JS-peer bootstrap multiaddress(es).`)
