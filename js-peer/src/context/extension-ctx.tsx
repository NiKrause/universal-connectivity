import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useLibp2pContext } from './ctx'
import { ExtensionManager } from '@/lib/extension-manager'
import { ExtensionProtocol } from '@/lib/extension-protocol'
import {
  ExtensionOffer,
  InstalledExtension,
  CommandResponse,
} from '@/lib/extension-types'

interface ExtensionContextType {
  manager: ExtensionManager | null
  protocol: ExtensionProtocol | null
  offers: ExtensionOffer[]
  installed: InstalledExtension[]
  installExtension: (extensionId: string) => boolean
  uninstallExtension: (extensionId: string) => boolean
  setExtensionEnabled: (extensionId: string, enabled: boolean) => boolean
  dismissOffer: (extensionId: string) => void
  executeCommand: (extensionId: string, command: string, args: string[]) => Promise<CommandResponse>
  isInstalled: (extensionId: string) => boolean
}

const ExtensionContext = createContext<ExtensionContextType | null>(null)

export function useExtensionContext() {
  const context = useContext(ExtensionContext)
  if (!context) {
    throw new Error('useExtensionContext must be used within ExtensionContextProvider')
  }
  return context
}

interface ExtensionContextProviderProps {
  children: React.ReactNode
}

export function ExtensionContextProvider({ children }: ExtensionContextProviderProps) {
  const { libp2p } = useLibp2pContext()
  const [manager, setManager] = useState<ExtensionManager | null>(null)
  const [protocol, setProtocol] = useState<ExtensionProtocol | null>(null)
  const [offers, setOffers] = useState<ExtensionOffer[]>([])
  const [installed, setInstalled] = useState<InstalledExtension[]>([])

  // Initialize extension manager and protocol when libp2p is ready
  useEffect(() => {
    if (!libp2p) {
      return
    }

    const initializeExtensions = async () => {
      try {
        // Create and start extension manager
        const extensionManager = new ExtensionManager(libp2p)
        await extensionManager.start()
        setManager(extensionManager)

        // Create and start extension protocol
        const extensionProtocol = new ExtensionProtocol(libp2p)
        await extensionProtocol.start()
        setProtocol(extensionProtocol)

        // Load initial state
        setOffers(extensionManager.getAvailableOffers())
        setInstalled(extensionManager.getInstalledExtensions())

        // Subscribe to changes
        const unsubscribe = extensionManager.onChange(() => {
          setOffers(extensionManager.getAvailableOffers())
          setInstalled(extensionManager.getInstalledExtensions())
        })

        return () => {
          unsubscribe()
          extensionManager.stop()
          extensionProtocol.stop()
        }
      } catch (error) {
        console.error('Failed to initialize extension system:', error)
      }
    }

    const cleanup = initializeExtensions()
    
    return () => {
      cleanup.then(fn => fn?.())
    }
  }, [libp2p])

  const installExtension = useCallback((extensionId: string) => {
    if (!manager) return false
    return manager.installExtension(extensionId)
  }, [manager])

  const uninstallExtension = useCallback((extensionId: string) => {
    if (!manager) return false
    return manager.uninstallExtension(extensionId)
  }, [manager])

  const setExtensionEnabled = useCallback((extensionId: string, enabled: boolean) => {
    if (!manager) return false
    return manager.setExtensionEnabled(extensionId, enabled)
  }, [manager])

  const dismissOffer = useCallback((extensionId: string) => {
    if (!manager) return
    manager.dismissOffer(extensionId)
  }, [manager])

  const executeCommand = useCallback(async (
    extensionId: string,
    command: string,
    args: string[]
  ): Promise<CommandResponse> => {
    if (!protocol) {
      throw new Error('Extension protocol not initialized')
    }
    return protocol.executeCommand(extensionId, command, args)
  }, [protocol])

  const isInstalled = useCallback((extensionId: string): boolean => {
    if (!manager) return false
    return manager.isInstalled(extensionId)
  }, [manager])

  const value: ExtensionContextType = {
    manager,
    protocol,
    offers,
    installed,
    installExtension,
    uninstallExtension,
    setExtensionEnabled,
    dismissOffer,
    executeCommand,
    isInstalled,
  }

  return (
    <ExtensionContext.Provider value={value}>
      {children}
    </ExtensionContext.Provider>
  )
}
