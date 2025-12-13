import React from 'react'
import { useExtensionContext } from '@/context/extension-ctx'

interface InstalledExtensionsProps {
  onExtensionClick: (extensionId: string) => void
}

export default function InstalledExtensions({ onExtensionClick }: InstalledExtensionsProps) {
  const { installed } = useExtensionContext()

  if (installed.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-2 ml-auto">
      <span className="text-xs text-gray-500 mr-1">Extensions:</span>
      {installed.map((ext) => (
        <button
          key={ext.manifest.id}
          onClick={() => onExtensionClick(ext.manifest.id)}
          className="group relative flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 hover:bg-blue-100 transition-colors border border-gray-200 hover:border-blue-300"
          title={`${ext.manifest.name} - Click for help`}
        >
          {ext.manifest.icon ? (
            <img
              src={ext.manifest.icon}
              alt={ext.manifest.name}
              className="w-5 h-5"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
                e.currentTarget.nextElementSibling?.classList.remove('hidden')
              }}
            />
          ) : null}
          <span className={`text-sm ${ext.manifest.icon ? 'hidden' : ''}`}>
            📦
          </span>
          
          {/* Tooltip - positioned below */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            {ext.manifest.name} - Click for help
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-800"></div>
          </div>
          
          {/* Enabled indicator */}
          {ext.enabled && (
            <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full border border-white"></span>
          )}
        </button>
      ))}
    </div>
  )
}
