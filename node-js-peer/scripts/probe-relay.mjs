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

async function probeAddress(node, rawAddr, timeoutMs, settleMs) {
  const addr = multiaddr(rawAddr)
  const peerIdString = addr.getPeerId()
  const protoNames = addr.protoNames()
  const startedAt = Date.now()

  const result = {
    address: rawAddr,
    protocols: protoNames,
    ok: false,
    dialMs: null,
    pingMs: null,
    remoteAddrs: [],
    error: null
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
        result.error = `dial succeeded but ping failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    result.ok = true
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

async function main() {
  const { addrs, timeoutMs, settleMs } = parseArgs(process.argv.slice(2))
  if (addrs.length === 0) {
    usage()
    process.exitCode = 1
    return
  }

  const node = await createProbeNode()
  try {
    const results = []
    for (const addr of addrs) {
      const result = await probeAddress(node, addr, timeoutMs, settleMs)
      results.push(result)
    }

    for (const result of results) {
      const summary = {
        address: result.address,
        protocols: result.protocols,
        ok: result.ok,
        dialMs: result.dialMs,
        pingMs: result.pingMs,
        remoteAddrs: result.remoteAddrs,
        error: result.error
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`)
    }

    if (results.some((result) => result.ok === false)) {
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
