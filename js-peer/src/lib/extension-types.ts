/**
 * Extension system types for UC decentralized plugin infrastructure
 */

/**
 * Command definition for an extension
 */
export interface ExtensionCommand {
  name: string
  syntax: string
  description: string
}

/**
 * Extension manifest - metadata about an extension
 */
export interface ExtensionManifest {
  id: string
  name: string
  description: string
  icon: string // URL to icon image
  publicUrl: string // URL where extension UI is hosted
  version: string
  commands: ExtensionCommand[]
  author?: string
}

/**
 * Extension offer - manifest broadcast by an extension on discovery topic
 */
export interface ExtensionOffer {
  manifest: ExtensionManifest
  timestamp: number
  publisherPeerId: string
}

/**
 * Installed extension - local storage representation
 */
export interface InstalledExtension {
  manifest: ExtensionManifest
  installDate: number
  enabled: boolean
}

/**
 * Parsed command from chat input
 */
export interface ParsedCommand {
  extensionId: string
  command: string
  args: string[]
  raw: string
}

/**
 * Command request message (published to extension command topic)
 */
export interface CommandRequest {
  type: 'command'
  extensionId: string
  command: string
  args: string[]
  requestId: string
  timestamp: number
}

/**
 * Command response message (received from extension)
 */
export interface CommandResponse {
  type: 'response'
  requestId: string
  success: boolean
  data?: any
  error?: string
  timestamp: number
}

/**
 * Extension discovery message (broadcast on discovery topic)
 */
export interface ExtensionDiscoveryMessage {
  type: 'offer'
  manifest: ExtensionManifest
  timestamp: number
}
