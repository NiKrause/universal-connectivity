import dynamic from 'next/dynamic'

import { useLibp2pContext } from '@/context/ctx'

const SponsorRelayFab = dynamic(
  () => import('@le-space/ui/react').then((mod) => mod.SponsorRelayFab),
  {
    ssr: false,
  },
)

export default function SponsorRelayNavButton() {
  const { libp2p } = useLibp2pContext()

  return (
    <SponsorRelayFab
      libp2p={libp2p}
      manifestUrl="https://connect.nicokrause.com/rootfs/uc-go-peer/latest.json"
      showInstances={true}
      instanceName="uc-relay"
      launcherMode="inline"
    />
  )
}
