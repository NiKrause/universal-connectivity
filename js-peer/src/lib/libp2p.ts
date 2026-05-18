import {
  createDelegatedRoutingV1HttpApiClient,
  type DelegatedRoutingV1HttpApiClient,
} from '@helia/delegated-routing-v1-http-api-client'
import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { peerIdFromString } from '@libp2p/peer-id'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { sha256 } from 'multiformats/hashes/sha2'
import type { Connection, Libp2p, Message, PeerId, SignedMessage } from '@libp2p/interface'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { ping } from '@libp2p/ping'
import { BOOTSTRAP_PEER_IDS, CHAT_FILE_TOPIC, CHAT_TOPIC, PUBSUB_PEER_DISCOVERY } from './constants'
import first from 'it-first'
import { directMessage } from './direct-message'
import { enable, forComponent } from './logger'
import type { Libp2pType } from '@/context/ctx'

const log = forComponent('libp2p')
const DEFAULT_DELEGATED_ROUTING_URL = 'https://delegated-ipfs.dev'

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function getConfiguredRelayListenAddrs(): string[] {
  return parseCsvEnv(process.env.NEXT_PUBLIC_RELAY_LISTEN_ADDRS)
}

function getConfiguredBootstrapPeerIds(): string[] {
  const configured = parseCsvEnv(process.env.NEXT_PUBLIC_BOOTSTRAP_PEER_IDS)
  if (configured.length > 0) {
    return configured
  }

  return BOOTSTRAP_PEER_IDS
}

function getDelegatedRoutingURL(): string {
  const configured = process.env.NEXT_PUBLIC_DELEGATED_ROUTING_URL?.trim()
  if (configured) {
    return configured
  }

  return DEFAULT_DELEGATED_ROUTING_URL
}

export async function startLibp2p(): Promise<Libp2pType> {
  enable('ui*,libp2p*,-libp2p:connection-manager*,-*:trace')

  const delegatedClient = createDelegatedRoutingV1HttpApiClient(getDelegatedRoutingURL())
  const relayBootstrapAddrs = await getRelayBootstrapAddrs(delegatedClient)
  log('starting libp2p with relayBootstrapAddrs: %o', relayBootstrapAddrs)

  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/webrtc'],
    },
    transports: [webTransport(), webSockets(), webRTC(), webRTCDirect(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
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
      delegatedRouting: () => delegatedClient,
      identify: identify(),
      directMessage: directMessage(),
      ping: ping(),
    },
  })

  libp2p.services.pubsub.subscribe(CHAT_TOPIC)
  libp2p.services.pubsub.subscribe(CHAT_FILE_TOPIC)

  libp2p.addEventListener('self:peer:update', ({ detail: { peer } }) => {
    const multiaddrs = peer.addresses.map(({ multiaddr }) => multiaddr)
    log('changed multiaddrs: peer %s multiaddrs: %o', peer.id.toString(), multiaddrs)
  })

  libp2p.addEventListener('peer:discovery', (event) => {
    const { multiaddrs, id } = event.detail

    const connectionCount = libp2p.getConnections(id)?.length ?? 0
    if (connectionCount > 0) {
      log(
        'peer %s rediscovered with %d existing connection(s), continuing dial attempt',
        id.toString(),
        connectionCount,
      )
    }

    void dialWebRTCMaddrs(libp2p, multiaddrs)
  })

  void (async () => {
    for (const addr of relayBootstrapAddrs) {
      try {
        log('dialling configured relay bootstrap address: %s', addr)
        await connectToMultiaddr(libp2p)(multiaddr(addr))
      } catch (error) {
        log.error('failed to dial configured relay bootstrap address %s: %o', addr, error)
      }
    }
  })().catch((error) => {
    log.error('bootstrap dial error: %o', error)
  })

  return libp2p as Libp2pType
}

export async function msgIdFnStrictNoSign(msg: Message): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const signedMessage = msg as SignedMessage
  const encodedSeqNum = enc.encode(signedMessage.sequenceNumber.toString())
  return await sha256.encode(encodedSeqNum)
}

async function dialWebRTCMaddrs(libp2p: Libp2p, multiaddrs: Multiaddr[]): Promise<void> {
  const webRtcMaddrs = multiaddrs.filter((maddr) => maddr.protoNames().includes('webrtc'))
  log('dialling WebRTC multiaddrs: %o', webRtcMaddrs)

  for (const addr of webRtcMaddrs) {
    try {
      log('attempting to dial webrtc multiaddr: %o', addr)
      await libp2p.dial(addr)
      return
    } catch (error) {
      log.error('failed to dial webrtc multiaddr: %o %o', addr, error)
    }
  }
}

export const connectToMultiaddr = (libp2p: Libp2p) => async (address: Multiaddr) => {
  log('dialling: %a', address)
  try {
    const conn = await libp2p.dial(address)
    log('connected to %p on %a', conn.remotePeer, conn.remoteAddr)
    return conn
  } catch (error) {
    console.error(error)
    throw error
  }
}

async function getRelayBootstrapAddrs(client: DelegatedRoutingV1HttpApiClient): Promise<string[]> {
  const configuredRelayListenAddrs = getConfiguredRelayListenAddrs()
  if (configuredRelayListenAddrs.length > 0) {
    log('using NEXT_PUBLIC_RELAY_LISTEN_ADDRS override as explicit relay bootstrap addresses')
    return configuredRelayListenAddrs
  }

  const bootstrapPeerIds = getConfiguredBootstrapPeerIds()
  const peers = await Promise.all(bootstrapPeerIds.map((peerId) => first(client.getPeers(peerIdFromString(peerId)))))

  const relayBootstrapAddrs: string[] = []
  for (const peer of peers) {
    if (!peer || peer.Addrs.length === 0) {
      continue
    }

    for (const maddr of peer.Addrs) {
      if (isBrowserDialableBootstrapAddr(maddr)) {
        relayBootstrapAddrs.push(getRelayBootstrapAddr(maddr, peer.ID))
      }
    }
  }

  return relayBootstrapAddrs
}

const getRelayBootstrapAddr = (maddr: Multiaddr, peer: PeerId): string => `${maddr.toString()}/p2p/${peer.toString()}`

function isBrowserDialableBootstrapAddr(maddr: Multiaddr): boolean {
  const protos = maddr.protoNames()
  const isSecureWebSocketAddr = protos.includes('tls') && protos.includes('ws')
  const isWebTransportAddr = protos.includes('webtransport')

  if (!isSecureWebSocketAddr && !isWebTransportAddr) {
    return false
  }

  try {
    const host = maddr.nodeAddress().address
    return host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0' && host !== '::'
  } catch {
    return true
  }
}

export const getFormattedConnections = (connections: Connection[]) =>
  connections.map((conn) => ({
    peerId: conn.remotePeer,
    protocols: [...new Set(conn.remoteAddr.protoNames())],
  }))
