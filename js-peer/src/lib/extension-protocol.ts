import type { Libp2pType } from '@/context/ctx'
import { peerIdFromString } from '@libp2p/peer-id'
import { v4 as uuidv4 } from 'uuid'
import { pbStream } from 'it-protobuf-stream'
import { ExtensionManager } from './extension-manager'
import { ext } from './protobuf/extension'
import {
  getExtensionProtocol,
} from './extension-types'

const COMMAND_TIMEOUT = 5000 // 5 seconds

/**
 * Extension command protocol - handles command execution via direct libp2p streams
 * 
 * Uses the same pattern as direct-message.ts for clean stream handling
 * Tries each known peer in order (last successful first) until one responds
 */
export class ExtensionProtocol {
  private libp2p: Libp2pType
  private extensionManager: ExtensionManager

  constructor(libp2p: Libp2pType, extensionManager: ExtensionManager) {
    this.libp2p = libp2p
    this.extensionManager = extensionManager
  }

  /**
   * Start the protocol
   */
  async start(): Promise<void> {
    console.log('✅ ExtensionProtocol: Started (using direct streams)')
  }

  /**
   * Stop the protocol
   */
  async stop(): Promise<void> {
    console.log('✅ ExtensionProtocol: Stopped')
  }

  /**
   * Execute a command on an extension
   * Tries each known peer until one responds successfully
   */
  async executeCommand(
    extensionId: string,
    command: string,
    args: string[]
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const extension = this.extensionManager.getExtension(extensionId)
    
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`)
    }

    const peerIds = this.extensionManager.getExtensionPeers(extensionId)
    
    if (peerIds.length === 0) {
      throw new Error(`No peers available for extension '${extensionId}'`)
    }

    const protocol = getExtensionProtocol(extensionId, extension.manifest.version)
    const errors: string[] = []

    // Try each peer in order (last successful first)
    for (const peerId of peerIds) {
      try {
        console.log(`🔗 Trying peer ${peerId.slice(-8)} for /${extensionId}-${command}`)
        const response = await this.executeOnPeer(peerId, protocol, extensionId, command, args)
        
        // Mark this peer as successful
        this.extensionManager.markPeerSuccess(extensionId, peerId)
        console.log(`✅ Command response from peer ${peerId.slice(-8)}`)
        
        return response
      } catch (error: any) {
        console.warn(`❌ Peer ${peerId.slice(-8)} failed:`, error.message)
        errors.push(`${peerId.slice(-8)}: ${error.message}`)
        // Continue to next peer
      }
    }

    // All peers failed
    throw new Error(`All peers failed for extension '${extensionId}':\n${errors.join('\n')}`)
  }

  /**
   * Execute a command on a specific peer
   * Uses pbStream exactly like direct-message.ts
   */
  private async executeOnPeer(
    peerId: string,
    protocol: string,
    extensionId: string,
    command: string,
    args: string[]
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const pId = peerIdFromString(peerId)
    const stream = await this.libp2p.dialProtocol(pId, protocol)
    const datastream = pbStream(stream)

    try {
      const requestId = uuidv4()
      // Wrap the command request in the Request wrapper message
      const request: ext.Request = {
        // @ts-ignore - payload field added for compatibility with test client
        payload: 'command',
        command: {
          requestId,
          extensionId,
          command,
          args,
          timestamp: BigInt(Date.now()),
        }
      }

      // Send request
      console.log(`📤 Sending command: /${extensionId}-${command}`)
      const signal = AbortSignal.timeout(COMMAND_TIMEOUT)
      await datastream.write(request, ext.Request, { signal })

      // Read response
      console.log(`📥 Waiting for command response...`)
      const response = await datastream.read(ext.Response, { signal })

      console.log(`📥 Received command response:`, {
        // @ts-ignore
        payload: response.payload,
        hasCommand: !!response.command,
        responseKeys: Object.keys(response)
      })
      
      // Check if it's a command response
      // Note: Some implementations don't send the payload field
      // @ts-ignore
      if ((response.payload === 'command' || !response.payload) && response.command) {
        if (response.command.requestId === requestId) {
          if (response.command.success) {
            return {
              success: true,
              data: response.command.data ? JSON.parse(response.command.data) : undefined,
            }
          }
          throw new Error(response.command.error || 'Command failed')
        }
      }
      
      throw new Error('Invalid response')
    } finally {
      try {
        await stream.close({ signal: AbortSignal.timeout(5000) })
      } catch (err: any) {
        stream.abort(err)
      }
    }
  }
}
