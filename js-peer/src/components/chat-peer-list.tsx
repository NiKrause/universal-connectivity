import { useLibp2pContext } from '@/context/ctx'
import { CHAT_TOPIC } from '@/lib/constants'
import React, { useEffect, useState } from 'react'
import type { PeerId, Message } from '@libp2p/interface'
import { PeerWrapper } from './peer'
import { peerIdFromString } from '@libp2p/peer-id'

interface ChatPeerListProps {
  hideHeader?: boolean
}

export function ChatPeerList({ hideHeader = false }: ChatPeerListProps) {
  const { libp2p } = useLibp2pContext()
  const [peers, setPeers] = useState<Set<string>>(new Set())

  useEffect(() => {
    // Track both subscribers and message senders
    const updatePeers = () => {
      const subscribers = libp2p.services.pubsub.getSubscribers(CHAT_TOPIC) as PeerId[]
      setPeers(prev => {
        const updated = new Set(prev)
        subscribers.forEach(peer => updated.add(peer.toString()))
        return updated
      })
    }

    const onMessage = (evt: CustomEvent<Message>) => {
      if (evt.detail.topic === CHAT_TOPIC && evt.detail.type === 'signed') {
        const senderId = evt.detail.from.toString()
        setPeers(prev => {
          if (!prev.has(senderId)) {
            const updated = new Set(prev)
            updated.add(senderId)
            return updated
          }
          return prev
        })
      }
    }

    updatePeers()
    libp2p.services.pubsub.addEventListener('subscription-change', updatePeers)
    libp2p.services.pubsub.addEventListener('message', onMessage)
    
    return () => {
      libp2p.services.pubsub.removeEventListener('subscription-change', updatePeers)
      libp2p.services.pubsub.removeEventListener('message', onMessage)
    }
  }, [libp2p])

  const peerList = Array.from(peers)
    .filter(peerId => peerId !== libp2p.peerId.toString())
    .sort()

  return (
    <div className="border-l border-gray-300 lg:col-span-1">
      {!hideHeader && <h2 className="my-2 mb-2 ml-2 text-lg text-gray-600">Peers ({peerList.length + 1})</h2>}
      <div className="overflow-auto h-[20rem] lg:h-[32rem]">
        <div className="px-3 py-2 border-b border-gray-300 focus:outline-none">
          {<PeerWrapper peer={libp2p.peerId} self withName={true} withUnread={false} />}
        </div>
        {peerList.map((peerIdStr) => {
          try {
            const peerId = peerIdFromString(peerIdStr)
            return (
              <div key={peerIdStr} className="border-b border-gray-300">
                <div className="px-3 py-2">
                  <PeerWrapper peer={peerId} self={false} withName={true} withUnread={true} />
                </div>
              </div>
            )
          } catch (e) {
            console.error(`Invalid peer ID: ${peerIdStr}`, e)
            return null
          }
        })}
      </div>
    </div>
  )
}
