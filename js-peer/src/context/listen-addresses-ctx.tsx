import React, { ReactNode } from 'react'

interface ListenAddressesProviderProps {
  children: ReactNode
}

export function ListenAddressesProvider({ children }: ListenAddressesProviderProps) {
  return <>{children}</>
}
