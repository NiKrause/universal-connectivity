import { createDelegatedRoutingV1HttpApiClient } from '@helia/delegated-routing-v1-http-api-client'
import { createLibp2p } from 'libp2p'
import { bootstrap } from '@libp2p/bootstrap'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'
import { Multiaddr } from '@multiformats/multiaddr'
import { sha256 } from 'multiformats/hashes/sha2'
import { FaultTolerance } from '@libp2p/interface'
import type { Connection, Message, SignedMessage, Libp2p } from '@libp2p/interface'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { ping } from '@libp2p/ping'
import { BOOTSTRAP_MULTIADDRS, CHAT_FILE_TOPIC, CHAT_TOPIC, PUBSUB_PEER_DISCOVERY } from './constants'
import { forComponent, enable } from './logger'
import { directMessage } from './direct-message'
import type { Libp2pType } from '@/context/ctx'

const log = forComponent('libp2p')

export async function startLibp2p(): Promise<Libp2pType> {
  // enable verbose logging in browser console to view debug logs
  enable('ui*,libp2p*,-libp2p:connection-manager*,-*:trace')
  const { webRTC, webRTCDirect } = await import('@libp2p/webrtc')

  const delegatedClient = createDelegatedRoutingV1HttpApiClient('https://delegated-ipfs.dev')
  const isolatedRelayE2E = process.env.NEXT_PUBLIC_E2E_RELAY_MODE === 'isolated'
  const discoveredBootstrapMultiaddrs = isolatedRelayE2E
    ? []
    : await discoverAlephBootstrapMultiaddrs().catch((error) => {
        log.error('failed to load Aleph bootstrap multiaddrs: %o', error)
        return []
      })
  const relayDialAddrStrings = isolatedRelayE2E
    ? []
    : [...new Set([...BOOTSTRAP_MULTIADDRS, ...discoveredBootstrapMultiaddrs])]
  log('starting libp2p with relayDialAddrs: %o', relayDialAddrStrings)

  let libp2p: Libp2pType

  libp2p = await createLibp2p({
    addresses: {
      listen: [
        // 👇 Listen for webRTC connection
        '/webrtc',
      ],
    },
    transports: [
      webTransport(),
      webSockets(),
      webRTC(),
      // 👇 Required to estalbish connections with peers supporting WebRTC-direct, e.g. the Rust-peer
      webRTCDirect(),
      // 👇 Required to create circuit relay reservations in order to hole punch browser-to-browser WebRTC connections
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    // Some deployed relays may advertise browser-dialable addresses that still
    // fail relay reservation from the browser. Allow startup to continue in
    // dial-only mode instead of failing the whole app.
    transportManager: {
      faultTolerance: FaultTolerance.NO_FATAL,
    },
    peerDiscovery: [
      ...(relayDialAddrStrings.length > 0
        ? [
            bootstrap({
              list: relayDialAddrStrings,
              timeout: 10_000,
              tagName: 'uc-bootstrap',
            }),
          ]
        : []),
      pubsubPeerDiscovery({
        interval: 10_000,
        topics: [PUBSUB_PEER_DISCOVERY],
        listenOnly: false,
      }),
    ],
    services: {
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        msgIdFn: msgIdFnStrictNoSign,
        ignoreDuplicatePublishError: true,
      }),
      // Keep delegated routing enabled for peer/content routing even though
      // bootstrap now prefers the dynamic Aleph bootstrap registry.
      delegatedRouting: () => delegatedClient,
      identify: identify(),
      // Custom protocol for direct messaging
      directMessage: directMessage(),
      ping: ping(),
    },
  })

  if (!libp2p) {
    throw new Error('Failed to create libp2p node')
  }

  libp2p.services.pubsub.subscribe(CHAT_TOPIC)
  libp2p.services.pubsub.subscribe(CHAT_FILE_TOPIC)

  libp2p.addEventListener('self:peer:update', ({ detail: { peer } }) => {
    const multiaddrs = peer.addresses.map(({ multiaddr }) => multiaddr)
    log(`changed multiaddrs: peer ${peer.id.toString()} multiaddrs: ${multiaddrs}`)
  })

  // 👇 explicitly dial peers discovered via pubsub
  libp2p.addEventListener('peer:discovery', (event) => {
    const { multiaddrs, id } = event.detail

    if (libp2p.getConnections(id)?.length > 0) {
      log(`Already connected to peer %s. Will not try dialling`, id)
      return
    }

    dialWebRTCMaddrs(libp2p, multiaddrs)
  })

  return libp2p
}

// message IDs are used to dedupe inbound messages
// every agent in network should use the same message id function
// messages could be perceived as duplicate if this isnt added (as opposed to rust peer which has unique message ids)
export async function msgIdFnStrictNoSign(msg: Message): Promise<Uint8Array> {
  var enc = new TextEncoder()

  const signedMessage = msg as SignedMessage
  const encodedSeqNum = enc.encode(signedMessage.sequenceNumber.toString())
  return await sha256.encode(encodedSeqNum)
}

// Function which dials one maddr at a time to avoid establishing multiple connections to the same peer
async function dialWebRTCMaddrs(libp2p: Libp2p, multiaddrs: Multiaddr[]): Promise<void> {
  // Filter webrtc (browser-to-browser) multiaddrs
  const webRTCMadrs = multiaddrs.filter((maddr) => maddr.protoNames().includes('webrtc'))
  log(`dialling WebRTC multiaddrs: %o`, webRTCMadrs)

  for (const addr of webRTCMadrs) {
    try {
      log(`attempting to dial webrtc multiaddr: %o`, addr)
      await libp2p.dial(addr)
      return // if we succeed dialing the peer, no need to try another address
    } catch (error) {
      log.error(`failed to dial webrtc multiaddr: %o`, addr)
    }
  }
}

export const connectToMultiaddr = (libp2p: Libp2p) => async (multiaddr: Multiaddr) => {
  log(`dialling: %a`, multiaddr)
  try {
    const conn = await libp2p.dial(multiaddr)
    log('connected to %p on %a', conn.remotePeer, conn.remoteAddr)
    return conn
  } catch (e) {
    console.error(e)
    throw e
  }
}

export const getFormattedConnections = (connections: Connection[]) =>
  connections.map((conn) => ({
    peerId: conn.remotePeer,
    protocols: [...new Set(conn.remoteAddr.protoNames())],
  }))
