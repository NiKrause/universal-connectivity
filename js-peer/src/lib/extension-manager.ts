import type { Libp2pType } from '@/context/ctx'
import type { IdentifyResult } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { pbStream } from 'it-protobuf-stream'
import { EXTENSION_PROTOCOL_PREFIX } from './constants'
import { ext } from './protobuf/extension'
import {
  ExtensionManifest,
  ExtensionOffer,
  InstalledExtension,
  parseExtensionProtocol,
} from './extension-types'

const STORAGE_KEY = 'uc-installed-extensions'
const MANIFEST_TIMEOUT = 5000 // 5 seconds

/**
 * Manages extension discovery via identify protocol and installation lifecycle
 */
export class ExtensionManager {
  private libp2p: Libp2pType
  private offers: Map<string, ExtensionOffer> = new Map()
  private installed: Map<string, InstalledExtension> = new Map()
  private listeners: Set<() => void> = new Set()
  private boundHandleIdentify: (evt: CustomEvent<IdentifyResult>) => void

  constructor(libp2p: Libp2pType) {
    this.libp2p = libp2p
    this.boundHandleIdentify = this.handleIdentify.bind(this)
    this.loadInstalledFromStorage()
  }

  /**
   * Initialize the extension manager - listen for peer:identify events
   */
  async start(): Promise<void> {
    // Listen for identify events from connected peers
    this.libp2p.addEventListener('peer:identify', this.boundHandleIdentify)
    console.log('✅ ExtensionManager: Listening for peer:identify events')

    // Check already connected peers
    const connections = this.libp2p.getConnections()
    for (const conn of connections) {
      const peerId = conn.remotePeer.toString()
      try {
        // Get protocols for this peer
        const peerInfo = await this.libp2p.peerStore.get(conn.remotePeer)
        if (peerInfo?.protocols) {
          this.processProtocols(peerId, peerInfo.protocols)
        }
      } catch (e) {
        // Peer info not available yet
      }
    }
  }

  /**
   * Stop the extension manager
   */
  async stop(): Promise<void> {
    this.libp2p.removeEventListener('peer:identify', this.boundHandleIdentify)
    console.log('✅ ExtensionManager: Stopped')
  }

  /**
   * Handle identify event when a peer is identified
   */
  private handleIdentify(evt: CustomEvent<IdentifyResult>): void {
    const { peerId, protocols } = evt.detail
    const peerIdStr = peerId.toString()

    console.log(`🔍 Peer identified: ${peerIdStr.slice(-8)} with ${protocols.length} protocols`)

    this.processProtocols(peerIdStr, protocols)
  }

  /**
   * Process protocols from a peer to find extension protocols
   */
  private processProtocols(peerId: string, protocols: string[]): void {
    for (const protocol of protocols) {
      if (protocol.startsWith(EXTENSION_PROTOCOL_PREFIX)) {
        const parsed = parseExtensionProtocol(protocol)
        if (parsed) {
          console.log(`📦 Found extension protocol: ${parsed.extensionId} v${parsed.version} from ${peerId.slice(-8)}`)
          this.handleExtensionDiscovery(peerId, parsed.extensionId, protocol)
        }
      }
    }
  }

  /**
   * Handle discovery of an extension from a peer
   */
  private async handleExtensionDiscovery(peerId: string, extensionId: string, protocol: string): Promise<void> {
    // Check if we already have this peer for this extension
    const existingOffer = this.offers.get(extensionId)
    if (existingOffer) {
      if (!existingOffer.peerIds.includes(peerId)) {
        existingOffer.peerIds.push(peerId)
        existingOffer.timestamp = Date.now()
        console.log(`📦 Added peer ${peerId.slice(-8)} to extension: ${extensionId}`)
        this.notifyListeners()
      }
      // Also update installed extension if exists
      this.updateInstalledPeers(extensionId, peerId)
      return
    }

    // Check if already installed - just update peers
    if (this.isInstalled(extensionId)) {
      this.updateInstalledPeers(extensionId, peerId)
      return
    }

    // Fetch manifest from this peer
    try {
      const manifest = await this.fetchManifest(peerId, protocol)
      
      if (!this.isValidManifest(manifest)) {
        console.warn(`ExtensionManager: Invalid manifest from ${peerId.slice(-8)} for ${extensionId}`)
        return
      }

      const offer: ExtensionOffer = {
        manifest,
        timestamp: Date.now(),
        peerIds: [peerId],
      }

      this.offers.set(extensionId, offer)
      console.log(`📦 New extension offer: ${manifest.name} (${extensionId}) from ${peerId.slice(-8)}`)
      this.notifyListeners()
    } catch (error) {
      console.error(`Failed to fetch manifest from ${peerId.slice(-8)} for ${extensionId}:`, error)
    }
  }

  /**
   * Fetch manifest from a peer via direct stream
   * Uses pbStream exactly like direct-message.ts
   */
  private async fetchManifest(peerId: string, protocol: string): Promise<ExtensionManifest> {
    const pId = peerIdFromString(peerId)
    const stream = await this.libp2p.dialProtocol(pId, protocol)
    const datastream = pbStream(stream)

    try {
      // Wrap the manifest request in the Request wrapper message
      const request: ext.Request = {
        payload: 'manifest',
        manifest: {
          timestamp: BigInt(Date.now()),
        }
      }

      // Send request
      console.log(`📤 Sending manifest request to ${peerId.slice(-8)}`)
      const signal = AbortSignal.timeout(MANIFEST_TIMEOUT)
      await datastream.write(request, ext.Request, { signal })

      // Read response with timeout
      console.log(`📤 ExtensionManager: Sending manifest request to ${peerId.slice(-8)}`)
      const response = await datastream.read(ext.Response, { signal })

      console.log(`📥 ExtensionManager: RAW manifest response received:`, response)
      console.log(`📥 ExtensionManager: Response structure:`, {
        payload: response.payload,
        hasManifest: !!response.manifest,
        manifestKeys: response.manifest ? Object.keys(response.manifest) : [],
        hasNestedManifest: !!(response.manifest?.manifest),
        responseKeys: Object.keys(response),
        fullResponse: JSON.stringify(response, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      })
      
      // Check if it's a manifest response
      // Note: Some implementations don't send the payload field, so we check for manifest presence
      if ((response.payload === 'manifest' || !response.payload) && response.manifest?.manifest) {
        const manifestData = response.manifest.manifest
        
        console.log(`🔍 Manifest data:`, {
          id: manifestData.id,
          name: manifestData.name,
          version: manifestData.version,
          hasCommands: !!manifestData.commands,
          commandsLength: manifestData.commands?.length
        })
        
        // Convert protobuf manifest to our ExtensionManifest type
        const converted = {
          id: manifestData.id || '',
          name: manifestData.name || '',
          version: manifestData.version || '',
          description: manifestData.description || '',
          author: manifestData.author || '',
          publicUrl: manifestData.publicUrl || '',
          icon: manifestData.icon || '',
          commands: (manifestData.commands || []).map(cmd => ({
            name: cmd.name || '',
            syntax: cmd.syntax || '',
            description: cmd.description || '',
          })),
        }
        
        console.log(`✅ Manifest converted successfully:`, converted)
        return converted
      }
      
      console.error(`❌ Invalid manifest response structure`)
      throw new Error('Invalid manifest response')
    } finally {
      try {
        await stream.close({ signal: AbortSignal.timeout(5000) })
      } catch (err: any) {
        stream.abort(err)
      }
    }
  }

  /**
   * Update peer list for installed extensions
   */
  private updateInstalledPeers(extensionId: string, peerId: string): void {
    const installed = this.installed.get(extensionId)
    if (installed && !installed.peerIds.includes(peerId)) {
      installed.peerIds.push(peerId)
      this.saveInstalledToStorage()
      console.log(`📦 Added peer ${peerId.slice(-8)} to installed extension: ${extensionId}`)
    }
  }

  /**
   * Validate extension manifest
   */
  private isValidManifest(manifest: any): manifest is ExtensionManifest {
    return (
      manifest &&
      typeof manifest.id === 'string' &&
      typeof manifest.name === 'string' &&
      typeof manifest.description === 'string' &&
      typeof manifest.icon === 'string' &&
      typeof manifest.publicUrl === 'string' &&
      typeof manifest.version === 'string' &&
      Array.isArray(manifest.commands)
    )
  }

  /**
   * Get all available extension offers
   */
  getAvailableOffers(): ExtensionOffer[] {
    return Array.from(this.offers.values())
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * Install an extension
   */
  installExtension(extensionId: string): boolean {
    const offer = this.offers.get(extensionId)
    
    if (!offer) {
      console.error(`Extension ${extensionId} not found in offers`)
      return false
    }

    if (this.isInstalled(extensionId)) {
      console.warn(`Extension ${extensionId} is already installed`)
      return false
    }

    const installedExtension: InstalledExtension = {
      manifest: offer.manifest,
      installDate: Date.now(),
      enabled: true,
      peerIds: [...offer.peerIds], // Copy all known peers
    }

    this.installed.set(extensionId, installedExtension)
    this.saveInstalledToStorage()
    
    // Remove from offers
    this.offers.delete(extensionId)
    
    console.log(`✅ Installed extension: ${offer.manifest.name} with ${offer.peerIds.length} peer(s)`)
    this.notifyListeners()
    return true
  }

  /**
   * Uninstall an extension
   */
  uninstallExtension(extensionId: string): boolean {
    if (!this.isInstalled(extensionId)) {
      console.warn(`Extension ${extensionId} is not installed`)
      return false
    }

    this.installed.delete(extensionId)
    this.saveInstalledToStorage()
    
    console.log(`🗑️  Uninstalled extension: ${extensionId}`)
    this.notifyListeners()
    return true
  }

  /**
   * Check if an extension is installed
   */
  isInstalled(extensionId: string): boolean {
    return this.installed.has(extensionId)
  }

  /**
   * Get all installed extensions
   */
  getInstalledExtensions(): InstalledExtension[] {
    return Array.from(this.installed.values())
  }

  /**
   * Get a specific installed extension
   */
  getExtension(extensionId: string): InstalledExtension | undefined {
    return this.installed.get(extensionId)
  }

  /**
   * Get peers for an extension (ordered: last successful first)
   */
  getExtensionPeers(extensionId: string): string[] {
    const ext = this.installed.get(extensionId)
    if (!ext) return []

    // Ensure peerIds is an array (defensive for old storage format)
    const peerIds = Array.isArray(ext.peerIds) ? ext.peerIds : []
    const lastSuccessfulPeerId = ext.lastSuccessfulPeerId
    
    if (lastSuccessfulPeerId && peerIds.includes(lastSuccessfulPeerId)) {
      return [lastSuccessfulPeerId, ...peerIds.filter(p => p !== lastSuccessfulPeerId)]
    }
    return [...peerIds]
  }

  /**
   * Mark a peer as last successful for an extension
   */
  markPeerSuccess(extensionId: string, peerId: string): void {
    const ext = this.installed.get(extensionId)
    if (ext) {
      ext.lastSuccessfulPeerId = peerId
      this.saveInstalledToStorage()
    }
  }

  /**
   * Remove a peer from an extension (e.g., when peer disconnects)
   */
  removePeer(extensionId: string, peerId: string): void {
    const ext = this.installed.get(extensionId)
    if (ext) {
      ext.peerIds = ext.peerIds.filter(p => p !== peerId)
      if (ext.lastSuccessfulPeerId === peerId) {
        ext.lastSuccessfulPeerId = undefined
      }
      this.saveInstalledToStorage()
    }

    const offer = this.offers.get(extensionId)
    if (offer) {
      offer.peerIds = offer.peerIds.filter(p => p !== peerId)
      if (offer.peerIds.length === 0) {
        this.offers.delete(extensionId)
      }
      this.notifyListeners()
    }
  }

  /**
   * Enable/disable an extension
   */
  setExtensionEnabled(extensionId: string, enabled: boolean): boolean {
    const extension = this.installed.get(extensionId)
    
    if (!extension) {
      console.warn(`Extension ${extensionId} is not installed`)
      return false
    }

    extension.enabled = enabled
    this.saveInstalledToStorage()
    this.notifyListeners()
    return true
  }

  /**
   * Dismiss an extension offer
   */
  dismissOffer(extensionId: string): void {
    this.offers.delete(extensionId)
    this.notifyListeners()
  }

  /**
   * Load installed extensions from localStorage
   */
  private loadInstalledFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) {
        return
      }

      const data: Array<[string, InstalledExtension]> = JSON.parse(stored)
      
      // Migrate old format: ensure peerIds is always an array
      for (const [, ext] of data) {
        if (!Array.isArray(ext.peerIds)) {
          ext.peerIds = []
        }
      }
      
      this.installed = new Map(data)
      console.log(`📦 Loaded ${this.installed.size} installed extension(s)`)
    } catch (error) {
      console.error('Failed to load installed extensions from storage:', error)
    }
  }

  /**
   * Save installed extensions to localStorage
   */
  private saveInstalledToStorage(): void {
    try {
      const data = Array.from(this.installed.entries())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      console.error('Failed to save installed extensions to storage:', error)
    }
  }

  /**
   * Subscribe to extension manager changes
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Notify all listeners of changes
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener()
      } catch (error) {
        console.error('Extension listener error:', error)
      }
    })
  }
}
