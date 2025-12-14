import { useLibp2pContext } from '@/context/ctx'
import { useEffect, useState } from 'react'
import { PeerId } from '@libp2p/interface'
import { useChatContext } from '@/context/chat-ctx'
import Blockies from 'react-18-blockies'

export interface PeerProps {
  peer: PeerId
  self: boolean
  withName: boolean
  withUnread: boolean
}

export function PeerWrapper({ peer, self, withName, withUnread }: PeerProps) {
  const { libp2p } = useLibp2pContext()
  const [identified, setIdentified] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const { setRoomId } = useChatContext()

  const handleSetRoomId = () => {
    setRoomId(peer.toString())
  }

  useEffect(() => {
    const checkPeerStatus = async () => {
      // Check if peer is connected
      const connections = libp2p.getConnections(peer)
      setIsConnected(connections.length > 0)
      
      // Check if peer is identified
      if (await libp2p.peerStore.has(peer)) {
        const p = await libp2p.peerStore.get(peer)
        if (p.protocols.length > 0) {
          setIdentified(true)
        }
      }
    }

    const handleIdentify = (evt: any) => {
      if (evt.detail.peerId.equals(peer)) {
        if (evt.detail.protocols?.length > 0) {
          setIdentified(true)
        }
      }
    }

    const handleConnectionChange = () => {
      const connections = libp2p.getConnections(peer)
      setIsConnected(connections.length > 0)
    }

    checkPeerStatus()
    
    // Listen for identify events to update state when peer gets identified
    libp2p.addEventListener('peer:identify', handleIdentify)
    libp2p.addEventListener('connection:open', handleConnectionChange)
    libp2p.addEventListener('connection:close', handleConnectionChange)
    
    return () => {
      libp2p.removeEventListener('peer:identify', handleIdentify)
      libp2p.removeEventListener('connection:open', handleConnectionChange)
      libp2p.removeEventListener('connection:close', handleConnectionChange)
    }
  }, [libp2p, peer])

  const isDMSupported = identified && libp2p.services.directMessage.isDMPeer(peer)

  if (self || !identified) {
    return <Peer peer={peer} self={self} withName={withName} withUnread={withUnread} isConnected={isConnected} isDMSupported={false} />
  }

  if (identified && isDMSupported) {
    return (
      <div className="relative inline-block text-left cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1" onClick={() => handleSetRoomId()}>
        <Peer peer={peer} self={self} withName={withName} withUnread={withUnread} isConnected={isConnected} isDMSupported={true} />
      </div>
    )
  }

  if (identified && !isDMSupported) {
    return (
      <div className="relative inline-block text-left group">
        <Peer peer={peer} self={self} withName={withName} withUnread={withUnread} isConnected={isConnected} isDMSupported={false} />
        <div className="absolute top-10 left-5 scale-0 rounded bg-white border text-gray-600 p-2 text-xs group-hover:scale-100 z-10">
          Direct{'\u00A0'}message unsupported
        </div>
      </div>
    )
  }
}

interface PeerDisplayProps extends PeerProps {
  isConnected?: boolean
  isDMSupported?: boolean
}

export function Peer({ peer, self, withName, withUnread, isConnected, isDMSupported }: PeerDisplayProps) {
  const { directMessages } = useChatContext()

  return (
    <div className="flex items-stretch text-sm transition duration-150 ease-in-out focus:outline-none relative text-left">
      <div className="relative">
        <Blockies seed={peer.toString()} size={15} scale={3} className="rounded max-h-10 max-w-10" />
        {isConnected !== undefined && (
          <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${
            isConnected ? 'bg-green-500' : 'bg-gray-400'
          }`} title={isConnected ? 'Connected' : 'Not connected'} />
        )}
      </div>
      {withName && (
        <div className="w-full">
          <div className="flex justify-between items-center">
            <span className={`block ml-2 font-semibold ${self ? 'text-indigo-700-600' : 'text-gray-600'}`}>
              {peer.toString().slice(-7)}
              {self && ' (You)'}
              {isDMSupported && <span className="ml-1 text-xs text-green-600">💬</span>}
            </span>
          </div>
          {withUnread && (
            <div className="ml-2 text-gray-600">
              {directMessages[peer.toString()]?.filter((m) => !m.read).length
                ? `(${directMessages[peer.toString()]?.filter((m) => !m.read).length} unread)`
                : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
