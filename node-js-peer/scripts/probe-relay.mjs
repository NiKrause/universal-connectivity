import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webSockets } from '@libp2p/websockets'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { quic } from '@chainsafe/libp2p-quic'
import { tcp } from '@libp2p/tcp'
import { ping } from '@libp2p/ping'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'

function parseJsonEnv(name, fallback) {
  const rawValue = process.env[name]
  if (rawValue == null || rawValue.trim() === '') {
    return fallback
  }

  try {
    return JSON.parse(rawValue)
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function getPolicy() {
  const requiredFamilies = new Set(parseJsonEnv('ALEPH_RELAY_PROBE_REQUIRED_FAMILIES_JSON', [
    'tcp',
    'direct-wss',
    'proxy-wss',
    'webtransport'
  ]))
  const bestEffortFamilies = new Set(parseJsonEnv('ALEPH_RELAY_PROBE_BEST_EFFORT_FAMILIES_JSON', ['webrtc-direct']))
  const proxyWssHostMatchers = parseJsonEnv('ALEPH_RELAY_PROBE_PROXY_WSS_HOST_MATCHERS_JSON', ['.2n6.me/'])

  return {
    requiredFamilies,
    bestEffortFamilies,
    proxyWssHostMatchers,
  }
}

function classifyAddress(rawAddr, protocols, policy) {
  if (protocols.includes('webrtc-direct')) {
    return {
      family: 'webrtc-direct',
      required: policy.requiredFamilies.has('webrtc-direct'),
    }
  }

  if (protocols.includes('webtransport')) {
    return {
      family: 'webtransport',
      required: policy.requiredFamilies.has('webtransport'),
    }
  }

  if (protocols.includes('ws') && policy.proxyWssHostMatchers.some((matcher) => rawAddr.includes(matcher))) {
    return {
      family: 'proxy-wss',
      required: policy.requiredFamilies.has('proxy-wss'),
    }
  }

  if (protocols.includes('ws')) {
    return {
      family: 'direct-wss',
      required: policy.requiredFamilies.has('direct-wss'),
    }
  }

  if (protocols.includes('tcp')) {
    return {
      family: 'tcp',
      required: policy.requiredFamilies.has('tcp'),
    }
  }

  return {
    family: 'other',
    required: policy.requiredFamilies.has('other'),
  }
}

function parseArgs(argv) {
  const result = {
    addrs: [],
    timeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? 20000),
    settleMs: Number(process.env.PROBE_SETTLE_MS ?? 1500),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--timeout-ms') {
      result.timeoutMs = Number(argv[index + 1] ?? result.timeoutMs)
      index += 1
      continue
    }
    if (arg === '--settle-ms') {
      result.settleMs = Number(argv[index + 1] ?? result.settleMs)
      index += 1
      continue
    }
    result.addrs.push(arg)
  }

  return result
}

function usage() {
  console.error(
    [
      'Usage:',
      '  npm run probe:relay -- <multiaddr> [<multiaddr> ...] [--timeout-ms 20000] [--settle-ms 1500]',
      '',
      'Examples:',
      '  npm run probe:relay -- "/ip4/93.186.192.85/tcp/24004/p2p/12D3Koo..."',
      '  npm run probe:relay -- "/dns4/example.2n6.me/tcp/443/tls/ws/p2p/12D3Koo..."',
    ].join('\n')
  )
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
  }
}

async function createProbeNode() {
  return await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/udp/0/quic-v1', '/webrtc-direct']
    },
    transports: [
      webSockets(),
      webRTC(),
      webRTCDirect(),
      circuitRelayTransport(),
      quic(),
      tcp()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false
    },
    services: {
      identify: identify(),
      ping: ping()
    }
  })
}

async function probeAddress(node, rawAddr, timeoutMs, settleMs, policy) {
  const addr = multiaddr(rawAddr)
  const peerIdString = addr.getPeerId()
  const protoNames = addr.protoNames()
  const classification = classifyAddress(rawAddr, protoNames, policy)
  const startedAt = Date.now()

  const result = {
    address: rawAddr,
    protocols: protoNames,
    family: classification.family,
    required: classification.required,
    ok: false,
    dialMs: null,
    pingMs: null,
    remoteAddrs: [],
    error: null,
    warning: null
  }

  try {
    await withTimeout(node.dial(addr), timeoutMs, `dial ${rawAddr}`)
    result.dialMs = Date.now() - startedAt

    if (peerIdString) {
      const peerId = peerIdFromString(peerIdString)
      await sleep(settleMs)
      const connections = node.getConnections(peerId)
      result.remoteAddrs = connections.map((connection) => connection.remoteAddr.toString())

      try {
        const pingStart = Date.now()
        await withTimeout(node.services.ping.ping(peerId), timeoutMs, `ping ${rawAddr}`)
        result.pingMs = Date.now() - pingStart
      } catch (error) {
        result.pingMs = null
        const message = `dial succeeded but ping failed: ${error instanceof Error ? error.message : String(error)}`
        if (policy.bestEffortFamilies.has(classification.family)) {
          result.warning = message
        } else {
          result.error = message
        }
      }
    }

    result.ok = true
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (policy.bestEffortFamilies.has(classification.family)) {
      result.warning = message
    } else {
      result.error = message
    }
    return result
  }
}

function summarizeResults(results) {
  const failuresByFamily = new Map()

  for (const result of results) {
    if (!result.required || result.ok) {
      continue
    }
    const entries = failuresByFamily.get(result.family) ?? []
    entries.push(result)
    failuresByFamily.set(result.family, entries)
  }

  return {
    hasRequiredFailures: failuresByFamily.size > 0,
    failuresByFamily,
  }
}

async function main() {
  const { addrs, timeoutMs, settleMs } = parseArgs(process.argv.slice(2))
  const policy = getPolicy()
  if (addrs.length === 0) {
    usage()
    process.exitCode = 1
    return
  }

  const node = await createProbeNode()
  try {
    const results = []
    for (const addr of addrs) {
      const result = await probeAddress(node, addr, timeoutMs, settleMs, policy)
      results.push(result)
    }

    for (const result of results) {
      const summary = {
        address: result.address,
        protocols: result.protocols,
        family: result.family,
        required: result.required,
        ok: result.ok,
        dialMs: result.dialMs,
        pingMs: result.pingMs,
        remoteAddrs: result.remoteAddrs,
        error: result.error,
        warning: result.warning
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`)
    }

    const { hasRequiredFailures } = summarizeResults(results)
    if (hasRequiredFailures) {
      process.exitCode = 1
    }
  } finally {
    await node.stop()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
