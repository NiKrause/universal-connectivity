import type { Message } from '@libp2p/interface'
import type { Libp2pType } from '@/context/ctx'
import { EXTENSION_DISCOVERY_TOPIC } from './constants'
import {
  ExtensionManifest,
  ExtensionOffer,
  InstalledExtension,
  ExtensionDiscoveryMessage,
} from './extension-types'

const STORAGE_KEY = 'uc-installed-extensions'
const MAX_OFFERS = 10

/**
 * Manages extension discovery, installation, and lifecycle
 */
export class ExtensionManager {
  private libp2p: Libp2pType
  private offers: Map<string, ExtensionOffer> = new Map()
  private installed: Map<string, InstalledExtension> = new Map()
  private listeners: Set<() => void> = new Set()

  constructor(libp2p: Libp2pType) {
    this.libp2p = libp2p
    this.loadInstalledFromStorage()
  }

  /**
   * Initialize the extension manager - subscribe to discovery topic
   */
  async start(): Promise<void> {
    try {
      await this.libp2p.services.pubsub.subscribe(EXTENSION_DISCOVERY_TOPIC)
      this.libp2p.services.pubsub.addEventListener('message', this.handleMessage.bind(this))
      console.log('✅ ExtensionManager: Subscribed to discovery topic')
    } catch (error) {
      console.error('Failed to subscribe to extension discovery topic:', error)
      throw error
    }
  }

  /**
   * Stop the extension manager - unsubscribe from discovery topic
   */
  async stop(): Promise<void> {
    try {
      this.libp2p.services.pubsub.removeEventListener('message', this.handleMessage.bind(this))
      // Note: We don't unsubscribe because libp2p might be shutting down
      console.log('✅ ExtensionManager: Stopped')
    } catch (error) {
      console.error('Failed to stop extension manager:', error)
    }
  }

  /**
   * Handle incoming pubsub messages on discovery topic
   */
  private handleMessage(evt: CustomEvent<Message>): void {
    const { topic, data } = evt.detail

    // Only process messages from extension discovery topic
    if (topic !== EXTENSION_DISCOVERY_TOPIC) {
      return
    }

    // Only process signed messages
    if (evt.detail.type !== 'signed') {
      console.warn('ExtensionManager: Ignoring unsigned discovery message')
      return
    }

    try {
      const messageText = new TextDecoder().decode(data)
      const message: ExtensionDiscoveryMessage = JSON.parse(messageText)

      if (message.type === 'offer') {
        this.handleExtensionOffer(message, evt.detail.from.toString())
      }
    } catch (error) {
      console.error('ExtensionManager: Failed to parse discovery message:', error)
    }
  }

  /**
   * Handle an extension offer message
   */
  private handleExtensionOffer(message: ExtensionDiscoveryMessage, publisherPeerId: string): void {
    const { manifest } = message
    
    // Validate manifest
    if (!this.isValidManifest(manifest)) {
      console.warn('ExtensionManager: Invalid manifest received', manifest)
      return
    }

    // Don't show offers for already installed extensions
    if (this.isInstalled(manifest.id)) {
      return
    }

    const offer: ExtensionOffer = {
      manifest,
      timestamp: Date.now(),
      publisherPeerId,
    }

    // Add to offers map (deduplicated by extension ID)
    this.offers.set(manifest.id, offer)

    // Limit number of offers
    if (this.offers.size > MAX_OFFERS) {
      // Remove oldest offer
      const oldestKey = Array.from(this.offers.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0]
      this.offers.delete(oldestKey)
    }

    console.log(`📦 New extension offer: ${manifest.name} (${manifest.id})`)
    this.notifyListeners()
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
    }

    this.installed.set(extensionId, installedExtension)
    this.saveInstalledToStorage()
    
    // Remove from offers
    this.offers.delete(extensionId)
    
    console.log(`✅ Installed extension: ${offer.manifest.name}`)
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
