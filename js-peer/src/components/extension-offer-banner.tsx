import React from 'react'
import { useExtensionContext } from '@/context/extension-ctx'

export default function ExtensionOfferBanner() {
  const { offers, installExtension, dismissOffer } = useExtensionContext()

  if (offers.length === 0) {
    return null
  }

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-md">
      {offers.map((offer) => (
        <div
          key={offer.manifest.id}
          className="bg-blue-50 border-l-4 border-blue-400 p-4 shadow-lg rounded"
        >
          <div className="flex items-start">
            <div className="flex-shrink-0">
              {offer.manifest.icon ? (
                <img
                  src={offer.manifest.icon}
                  alt={offer.manifest.name}
                  className="h-10 w-10 rounded"
                  onError={(e) => {
                    // Fallback to emoji if icon fails to load
                    e.currentTarget.style.display = 'none'
                  }}
                />
              ) : (
                <div className="h-10 w-10 bg-blue-400 rounded flex items-center justify-center text-white text-xl">
                  📦
                </div>
              )}
            </div>
            <div className="ml-3 flex-1">
              <h3 className="text-sm font-medium text-blue-800">
                New Extension Available
              </h3>
              <div className="mt-1">
                <p className="text-sm font-semibold text-gray-800">
                  {offer.manifest.name}
                </p>
                <p className="text-xs text-gray-600 mt-1">
                  {offer.manifest.description}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {offer.peerIds.length === 1 
                    ? `From: ...${offer.peerIds[0].slice(-8)}`
                    : `From ${offer.peerIds.length} peers`
                  }
                </p>
                {offer.manifest.commands && offer.manifest.commands.length > 0 && (
                  <p className="text-xs text-gray-600 mt-1">
                    Commands: {offer.manifest.commands.map(cmd => `/${offer.manifest.id}-${cmd.name}`).join(', ')}
                  </p>
                )}
              </div>
              <div className="mt-3 flex space-x-2">
                <button
                  onClick={() => installExtension(offer.manifest.id)}
                  className="inline-flex items-center px-3 py-1 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Install
                </button>
                <button
                  onClick={() => dismissOffer(offer.manifest.id)}
                  className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
