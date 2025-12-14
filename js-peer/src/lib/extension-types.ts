/**
 * Extension system types for UC decentralized plugin infrastructure
 * 
 * Uses libp2p identify protocol for discovery and direct streams for communication
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
  icon: string // URL to icon image or data URI
  publicUrl: string // URL where extension UI is hosted
  version: string
  commands: ExtensionCommand[]
  author?: string
}

/**
 * Extension offer - discovered via identify protocol
 * Tracks all peers offering this extension
 */
export interface ExtensionOffer {
  manifest: ExtensionManifest
  timestamp: number
  peerIds: string[] // All peers offering this extension
}

/**
 * Installed extension - local storage representation
 */
export interface InstalledExtension {
  manifest: ExtensionManifest
  installDate: number
  enabled: boolean
  peerIds: string[] // All known peers for this extension
  lastSuccessfulPeerId?: string // Last peer that responded successfully
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

// Note: Protocol message types (ManifestRequest, ManifestResponse, CommandRequest, CommandResponse)
// are now defined in protobuf format in src/lib/protobuf/extension.proto
// Import them from '@/lib/protobuf/extension' as needed

/**
 * Helper to create protocol string for an extension
 */
export function getExtensionProtocol(extensionId: string, version: string = '1.0.0'): string {
  return `/uc/extension/${extensionId}/${version}`
}

/**
 * Helper to parse extension ID from protocol string
 */
export function parseExtensionProtocol(protocol: string): { extensionId: string; version: string } | null {
  const match = protocol.match(/^\/uc\/extension\/([^/]+)\/([^/]+)$/)
  if (match) {
    return { extensionId: match[1], version: match[2] }
  }
  return null
}
