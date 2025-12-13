import type { Message } from '@libp2p/interface'
import type { Libp2pType } from '@/context/ctx'
import { v4 as uuidv4 } from 'uuid'
import { CommandRequest, CommandResponse } from './extension-types'

const COMMAND_TIMEOUT = 5000 // 5 seconds

/**
 * Get the pubsub topic for an extension's command channel
 */
function getExtensionCommandTopic(extensionId: string): string {
  return `uc-ext-${extensionId}-commands`
}

/**
 * Extension command protocol - handles command execution via pubsub
 */
export class ExtensionProtocol {
  private libp2p: Libp2pType
  private pendingRequests: Map<string, {
    resolve: (response: CommandResponse) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }> = new Map()
  private subscribedTopics: Set<string> = new Set()

  constructor(libp2p: Libp2pType) {
    this.libp2p = libp2p
  }

  /**
   * Start the protocol - set up message listener
   */
  async start(): Promise<void> {
    this.libp2p.services.pubsub.addEventListener('message', this.handleMessage.bind(this))
    console.log('✅ ExtensionProtocol: Started')
  }

  /**
   * Stop the protocol - clean up
   */
  async stop(): Promise<void> {
    this.libp2p.services.pubsub.removeEventListener('message', this.handleMessage.bind(this))
    
    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Protocol stopped'))
    }
    this.pendingRequests.clear()
    
    console.log('✅ ExtensionProtocol: Stopped')
  }

  /**
   * Execute a command on an extension
   */
  async executeCommand(
    extensionId: string,
    command: string,
    args: string[]
  ): Promise<CommandResponse> {
    const topic = getExtensionCommandTopic(extensionId)
    
    // Subscribe to the extension's command topic if not already subscribed
    if (!this.subscribedTopics.has(topic)) {
      try {
        await this.libp2p.services.pubsub.subscribe(topic)
        this.subscribedTopics.add(topic)
        console.log(`📡 Subscribed to extension topic: ${topic}`)
      } catch (error) {
        throw new Error(`Failed to subscribe to extension topic: ${error}`)
      }
    }

    const requestId = uuidv4()
    const request: CommandRequest = {
      type: 'command',
      extensionId,
      command,
      args,
      requestId,
      timestamp: Date.now(),
    }

    // Create promise that will be resolved when we get a response
    const responsePromise = new Promise<CommandResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Command timeout: no response from extension '${extensionId}'`))
      }, COMMAND_TIMEOUT)

      this.pendingRequests.set(requestId, { resolve, reject, timeout })
    })

    // Publish the command request
    try {
      const messageData = new TextEncoder().encode(JSON.stringify(request))
      await this.libp2p.services.pubsub.publish(topic, messageData)
      console.log(`📤 Sent command: /${extensionId}-${command} ${args.join(' ')}`)
    } catch (error) {
      this.pendingRequests.delete(requestId)
      throw new Error(`Failed to publish command: ${error}`)
    }

    return responsePromise
  }

  /**
   * Handle incoming pubsub messages (looking for command responses)
   */
  private handleMessage(evt: CustomEvent<Message>): void {
    const { topic, data } = evt.detail

    // Check if this is an extension command topic we're interested in
    if (!topic.startsWith('uc-ext-') || !topic.endsWith('-commands')) {
      return
    }

    // Only process signed messages
    if (evt.detail.type !== 'signed') {
      return
    }

    try {
      const messageText = new TextDecoder().decode(data)
      const message = JSON.parse(messageText)

      if (message.type === 'response') {
        this.handleCommandResponse(message as CommandResponse)
      }
    } catch (error) {
      console.error('ExtensionProtocol: Failed to parse message:', error)
    }
  }

  /**
   * Handle a command response
   */
  private handleCommandResponse(response: CommandResponse): void {
    const pending = this.pendingRequests.get(response.requestId)
    
    if (!pending) {
      // Response for a request we don't know about (maybe timed out already)
      return
    }

    // Clear timeout and resolve/reject the promise
    clearTimeout(pending.timeout)
    this.pendingRequests.delete(response.requestId)

    if (response.success) {
      pending.resolve(response)
      console.log(`✅ Command response received (success)`)
    } else {
      pending.reject(new Error(response.error || 'Command failed'))
      console.error(`❌ Command response received (error): ${response.error}`)
    }
  }

  /**
   * Get command topic for an extension (utility for extensions to use)
   */
  static getCommandTopic(extensionId: string): string {
    return getExtensionCommandTopic(extensionId)
  }
}
