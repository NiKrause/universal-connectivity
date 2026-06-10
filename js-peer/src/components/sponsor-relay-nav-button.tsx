import dynamic from 'next/dynamic'
import React from 'react'

const SponsorRelayFab = dynamic(() => import('@le-space/ui/react').then((mod) => mod.SponsorRelayFab), {
  ssr: false,
})

export default function SponsorRelayNavButton() {
  const configuredAlephDomain = process.env.NEXT_PUBLIC_ALEPH_DOMAIN?.trim()
  const manifestUrl = configuredAlephDomain
    ? `https://${configuredAlephDomain}/rootfs/uc-go-peer/latest.json`
    : typeof window !== 'undefined'
      ? new URL('/rootfs/uc-go-peer/latest.json', window.location.origin).toString()
      : '/rootfs/uc-go-peer/latest.json'

  return (
    <div
      style={
        {
          '--le-space-sponsor-relay-launcher-start': '#4f46e5',
          '--le-space-sponsor-relay-launcher-end': '#6366f1',
          '--le-space-sponsor-relay-launcher-border': 'rgba(199, 210, 254, 0.42)',
          '--le-space-sponsor-relay-launcher-badge-bg': 'rgba(49, 46, 129, 0.92)',
          '--le-space-sponsor-relay-launcher-badge-border': 'rgba(191, 219, 254, 0.24)',
          '--le-space-sponsor-relay-launcher-dot': '#f59e0b',
          '--le-space-sponsor-relay-launcher-dot-ring': 'rgba(245, 158, 11, 0.18)',
          '--le-space-sponsor-relay-launcher-shadow': '0 10px 24px rgba(99, 102, 241, 0.22)',
          '--le-space-sponsor-relay-launcher-hover-shadow': '0 14px 30px rgba(79, 70, 229, 0.28)',
          '--le-space-sponsor-relay-panel-bg': 'rgba(49, 46, 129, 0.94)',
          '--le-space-sponsor-relay-panel-border': 'rgba(199, 210, 254, 0.22)',
          '--le-space-sponsor-relay-panel-shadow': '0 28px 80px rgba(49, 46, 129, 0.34)',
          '--le-space-sponsor-relay-backdrop-accent': 'rgba(79, 70, 229, 0.2)',
        } as React.CSSProperties
      }
    >
      <SponsorRelayFab
        manifestUrl={manifestUrl}
        sshPublicKey={process.env.NEXT_PUBLIC_VM_SSH_PUBLIC_KEY ?? ''}
        showInstances={true}
        instanceName="uc-relay"
        launcherMode="inline"
      />
    </div>
  )
}
