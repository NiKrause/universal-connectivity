import React, { ReactNode } from 'react'

interface PeerProviderProps {
  children: ReactNode
}

export function PeerProvider({ children }: PeerProviderProps) {
  return <>{children}</>
}
