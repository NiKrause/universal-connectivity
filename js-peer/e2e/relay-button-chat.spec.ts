import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { privateKeyToAccount } from 'viem/accounts'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'

const PRIVATE_KEY = process.env.RELAY_BUTTON_E2E_PRIVATE_KEY?.trim()
const SSH_PUBLIC_KEY = process.env.RELAY_BUTTON_E2E_SSH_PUBLIC_KEY?.trim()
const APP_URL = process.env.RELAY_BUTTON_E2E_APP_URL ?? 'http://127.0.0.1:4173'
const OUTPUT_DIR = 'test-results/relay-button-chat'
const PROVISION_TIMEOUT = 32 * 60_000
const REGISTRATION_VISIBILITY_TIMEOUT = 90_000
const RELAY_READINESS_TIMEOUT = 8 * 60_000
const CHAT_TIMEOUT = 3 * 60_000
const DELETE_TIMEOUT = 5 * 60_000
const UI_DELETE_GRACE_PERIOD = 20_000
const CLEANUP_INSTANCE_HASHES = (process.env.RELAY_BUTTON_E2E_CLEANUP_INSTANCE_HASHES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

type EvidenceStep = { label: string; status: 'pending' | 'passed' | 'failed' | 'skipped'; detail?: string }
type BootstrapContent = {
  peerId?: string
  registrationId?: string
  updatedAt?: number
  ownerAddress?: string
  publisherAddress?: string
  browserMultiaddrs?: string[]
  multiaddrs?: string[]
}

async function installWalletProvider(context: BrowserContext, account: ReturnType<typeof privateKeyToAccount>) {
  await context.exposeBinding('__relayE2eWalletRequest', async (_source, { method, params = [] }) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return '0x1'
      case 'personal_sign': {
        const payload = params.find(
          (value: unknown) =>
            typeof value === 'string' &&
            value.startsWith('0x') &&
            value.toLowerCase() !== account.address.toLowerCase(),
        )
        if (!payload || typeof payload !== 'string') throw new Error('personal_sign did not contain a payload')
        return account.signMessage({ message: { raw: payload as `0x${string}` } })
      }
      default:
        throw new Error(`Unsupported E2E wallet method: ${method}`)
    }
  })

  await context.addInitScript(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        isMetaMask: true,
        request: (request: unknown) =>
          (
            window as unknown as { __relayE2eWalletRequest: (value: unknown) => Promise<unknown> }
          ).__relayE2eWalletRequest(request),
        on(event: string, listener: (...args: unknown[]) => void) {
          const eventListeners = listeners.get(event) ?? new Set()
          eventListeners.add(listener)
          listeners.set(event, eventListeners)
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener)
        },
      },
    })
  })
}

async function findAlephInstanceHash(ownerAddress: string, instanceName: string, startedAt: number) {
  const deadline = Date.now() + 60_000
  const apiHosts = ['https://api2.aleph.im', 'https://api.aleph.im']

  while (Date.now() < deadline) {
    for (const apiHost of apiHosts) {
      try {
        const url = new URL('/api/v0/messages.json', apiHost)
        url.searchParams.set('msgTypes', 'INSTANCE')
        url.searchParams.set('addresses', ownerAddress)
        url.searchParams.set('message_statuses', 'processed,pending,rejected')
        url.searchParams.set('pagination', '100')
        url.searchParams.set('page', '1')
        url.searchParams.set('sortOrder', '-1')
        const response = await fetch(url, { cache: 'no-cache' })
        if (!response.ok) continue
        const payload = (await response.json()) as { messages?: Record<string, unknown>[] }
        const instance = payload.messages?.find((message) => {
          const content = message.content as { metadata?: { name?: string } } | undefined
          const timestamp = Number(message.reception_time ?? message.time ?? 0) * 1000
          return content?.metadata?.name === instanceName && timestamp >= startedAt - 60_000
        })
        if (typeof instance?.item_hash === 'string' && instance.item_hash) return instance.item_hash
      } catch {
        // Try the next Aleph API host until the deployment becomes queryable.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`Could not resolve the full Aleph instance hash for ${instanceName}`)
}

async function waitForAlephInstanceDeletion(instanceHash: string, timeout = DELETE_TIMEOUT) {
  const deadline = Date.now() + timeout
  const apiHosts = ['https://api2.aleph.im', 'https://api.aleph.im']
  const schedulerUrl = `https://scheduler.api.aleph.cloud/api/v0/allocation/${instanceHash}`
  let lastSummary = 'Deletion has not been observed yet.'

  while (Date.now() < deadline) {
    let forgotten = false
    const observations: string[] = []

    for (const apiHost of apiHosts) {
      try {
        const response = await fetch(new URL(`/api/v0/messages/${instanceHash}`, apiHost), { cache: 'no-cache' })
        if (!response.ok) {
          observations.push(`${apiHost}: HTTP ${response.status}`)
          continue
        }
        const payload = (await response.json()) as { status?: string; forgotten_by?: string[] }
        const hostForgotten = payload.status === 'forgotten' || Boolean(payload.forgotten_by?.length)
        forgotten ||= hostForgotten
        observations.push(`${apiHost}: ${payload.status ?? 'unknown'}`)
      } catch (error) {
        observations.push(`${apiHost}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    let unallocated = false
    try {
      const response = await fetch(schedulerUrl, { cache: 'no-cache' })
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      unallocated = response.status === 404 || payload?.error === 'VM is not allocated to any node'
      observations.push(`scheduler: ${unallocated ? 'unallocated' : `HTTP ${response.status}`}`)
    } catch (error) {
      observations.push(`scheduler: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (forgotten && unallocated) return observations.join('; ')
    lastSummary = observations.join('; ')
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }

  throw new Error(`Aleph instance ${instanceHash} was not deleted within ${timeout / 1000}s: ${lastSummary}`)
}

async function cleanupAlephInstance(
  account: ReturnType<typeof privateKeyToAccount>,
  instanceHash: string,
  eraseFirst: boolean,
) {
  if (!/^[a-f0-9]{64}$/iu.test(instanceHash)) throw new Error(`Invalid Aleph instance hash: ${instanceHash}`)

  const { eraseInstanceOnCrn, forgetAlephMessages } = await import('@le-space/core')
  const signer = (_sender: string, payload: string) => account.signMessage({ message: payload })
  const hasher = (payload: string) => createHash('sha256').update(payload).digest('hex')
  let eraseSummary = 'CRN erase already requested by the Relay Button UI'

  if (eraseFirst) {
    try {
      const eraseResult = await eraseInstanceOnCrn({
        sender: account.address,
        signer,
        instanceHash,
        fetch,
        apiHost: 'https://api2.aleph.im',
      })
      eraseSummary = `CRN ${eraseResult.status}${eraseResult.crnUrl ? ` at ${eraseResult.crnUrl}` : ''}`
    } catch (error) {
      // FORGET is still required even when the runtime is already absent or
      // its former CRN can no longer be reached.
      eraseSummary = `CRN erase unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const forgetResult = await forgetAlephMessages({
    sender: account.address,
    hashes: [instanceHash],
    reason: 'Relay Button E2E cleanup',
    signer,
    hasher,
    fetch,
    apiHost: 'https://api2.aleph.im',
    sync: true,
  })
  if (forgetResult.status === 'rejected') {
    throw new Error(`Aleph rejected cleanup for ${instanceHash}: ${JSON.stringify(forgetResult.response)}`)
  }

  const deletionSummary = await waitForAlephInstanceDeletion(instanceHash)
  return `${eraseSummary}; FORGET ${forgetResult.itemHash} ${forgetResult.status}; ${deletionSummary}`
}

async function waitForDeploymentInstance(page: Page, instanceName: string, ownerAddress: string, startedAt: number) {
  const outcome = await page.waitForFunction(
    (expectedName) => {
      const instance = [...document.querySelectorAll('details')].find(
        (element) =>
          element.textContent?.includes(expectedName) &&
          [...element.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Delete'),
      )
      if (instance?.textContent?.includes('Aleph bootstrap registered')) return { status: 'instance' }
      const error = document.querySelector('aside.panel .alert.error')?.textContent?.trim()
      if (error) return { status: 'error', message: error }
      const panelText = document.querySelector('aside')?.textContent ?? ''
      const deployButton = [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Deploy'),
      )
      if (panelText.includes('Deployment failed') && !deployButton?.textContent?.includes('Deploying')) {
        return { status: 'error', message: panelText }
      }
      return null
    },
    instanceName,
    { timeout: PROVISION_TIMEOUT, polling: 500 },
  )
  const result = await outcome.jsonValue()
  if (result?.status === 'error') throw new Error(`Relay Button deployment failed: ${result.message}`)

  const instance = page
    .locator('details')
    .filter({ hasText: instanceName })
    .filter({ has: page.getByRole('button', { name: 'Delete', exact: true }) })
    .first()
  const instanceHash = await findAlephInstanceHash(ownerAddress, instanceName, startedAt)
  return { instance, instanceHash }
}

async function waitForDeployableManifest(page: Page) {
  const outcome = await page.waitForFunction(
    () => {
      const deployButton = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Deploy Relay',
      ) as HTMLButtonElement | undefined
      if (!deployButton) return null
      if (!deployButton.disabled) return { status: 'ready' }

      const panelText = deployButton.closest('aside')?.textContent ?? document.body.textContent ?? ''
      const terminalRootfsStates = [
        'manifest rootfs not deployable',
        'manifest invalid',
        'not found on Aleph',
        'Rootfs unavailable — deployment blocked',
        'Rejected by Aleph',
      ]
      const rootfsFailure = terminalRootfsStates.find((state) => panelText.includes(state))
      return rootfsFailure ? { status: 'error', message: rootfsFailure } : null
    },
    undefined,
    { timeout: 120_000, polling: 500 },
  )
  const result = await outcome.jsonValue()
  if (result?.status === 'error') {
    throw new Error(
      `Relay Button manifest is not deployable: ${result.message}. Republish the rootfs and update latest.json before provisioning.`,
    )
  }
}

async function waitForBootstrapRegistration(ownerAddress: string, instanceName: string, startedAt: number) {
  // The package exposes an ESM-only entry point. Dynamic import keeps this
  // compatible with Playwright's CommonJS transform in this Next.js app.
  const { fetchAlephBootstrapPosts } = await import('@le-space/aleph-bootstrap')

  const deadline = Date.now() + REGISTRATION_VISIBILITY_TIMEOUT
  let lastSummary = 'No bootstrap posts returned.'

  while (Date.now() < deadline) {
    const posts = await fetchAlephBootstrapPosts({ pagination: 200 }).catch((error) => {
      lastSummary = error instanceof Error ? error.message : String(error)
      return []
    })

    const registration = posts.find(({ address, content }) => {
      const candidate = content as BootstrapContent
      const owner = (candidate.ownerAddress ?? candidate.publisherAddress ?? address)?.toLowerCase()
      const addresses = candidate.browserMultiaddrs?.length ? candidate.browserMultiaddrs : candidate.multiaddrs
      return (
        owner === ownerAddress.toLowerCase() &&
        candidate.registrationId?.includes(`:${instanceName}:`) &&
        Number(candidate.updatedAt ?? 0) >= startedAt - 60_000 &&
        (addresses?.length ?? 0) > 0
      )
    })
    if (registration) return registration
    lastSummary = `${posts.length} posts checked; no current registration for ${instanceName}`
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }

  throw new Error(`Relay bootstrap registration timed out: ${lastSummary}`)
}

function selectBrowserRelayAddresses(content: BootstrapContent) {
  const addresses = content.browserMultiaddrs?.length ? content.browserMultiaddrs : (content.multiaddrs ?? [])
  return addresses
    .filter((address) => {
      if (/\/(tls\/ws|wss)\/p2p\//.test(address)) return true

      // Browsers can dial WebTransport and WebRTC Direct addresses, but both
      // transports must carry the certificate hash needed to authenticate the
      // remote endpoint. Do not let an incomplete advertised address make the
      // provisioning test look successful.
      if (/\/webtransport\//.test(address)) {
        return (address.match(/\/certhash\//g)?.length ?? 0) > 0 && /\/p2p\//.test(address)
      }
      if (/\/webrtc-direct\//.test(address)) {
        return (address.match(/\/certhash\//g)?.length ?? 0) > 0 && /\/p2p\//.test(address)
      }
      return false
    })
    .sort((left, right) => {
      const rank = (address: string) => {
        if (address.includes('/webtransport/')) return 0
        if (address.includes('/webrtc-direct/')) return 1
        if (address.includes('.libp2p.direct/')) return 2
        if (address.includes('.2n6.me/')) return 3
        return 4
      }
      return rank(left) - rank(right)
    })
}

class ChatBrowserAgent {
  context: BrowserContext | null = null
  page: Page | null = null

  constructor(
    readonly name: string,
    readonly browser: Browser,
  ) {}

  async open() {
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
    await this.page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await this.page.getByPlaceholder('Message').waitFor({ state: 'visible', timeout: 120_000 })
    await this.page.waitForFunction(
      () => Boolean((window as unknown as { libp2p?: { peerId?: unknown } }).libp2p?.peerId),
      undefined,
      { timeout: 120_000 },
    )
  }

  async peerId() {
    return this.requiredPage().evaluate(() =>
      String((window as unknown as { libp2p: { peerId: unknown } }).libp2p.peerId),
    )
  }

  async connectToRelay(addresses: string[], relayPeerId: string) {
    const deadline = Date.now() + RELAY_READINESS_TIMEOUT
    const attempts: { address: string; error?: string }[] = []

    while (Date.now() < deadline) {
      for (const address of addresses) {
        const page = this.requiredPage()
        try {
          if (
            !(await page
              .getByRole('dialog')
              .isVisible()
              .catch(() => false))
          ) {
            // The existing node-info dialog is the application's supported
            // manual dial path. Its compact label changes to "Node" on mobile.
            await page.getByRole('button', { name: /libp2p node info|Node/ }).click()
          }
          const dialog = page.getByRole('dialog')
          await dialog.getByLabel('Multiaddr to connect to').fill(address)
          await dialog.getByRole('button', { name: /Connect to multiaddr/ }).click()
          await this.waitForRelayConnection(relayPeerId, 20_000)
          await page.keyboard.press('Escape')
          return { address, attempts }
        } catch (error) {
          attempts.push({ address, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    throw new Error(`${this.name} did not connect to ${relayPeerId}: ${JSON.stringify(attempts)}`)
  }

  async waitForRelayConnection(relayPeerId: string, timeout = CHAT_TIMEOUT) {
    await this.requiredPage().waitForFunction(
      (expectedPeerId) =>
        (
          (
            window as unknown as { libp2p: { getConnections: () => { remotePeer: unknown }[] } }
          ).libp2p.getConnections() ?? []
        ).some(({ remotePeer }) => String(remotePeer) === expectedPeerId),
      relayPeerId,
      { timeout, polling: 1_000 },
    )
  }

  async sendMessage(message: string) {
    const input = this.requiredPage().getByPlaceholder('Message')
    await input.fill(message)
    await input.press('Enter')
  }

  async waitForMessage(message: string) {
    await this.requiredPage()
      .getByTestId('chat-message-body')
      .filter({ hasText: message })
      .waitFor({ state: 'visible', timeout: CHAT_TIMEOUT })
  }

  async screenshot(path: string) {
    await this.page?.screenshot({ path, fullPage: true })
  }

  async diagnostics() {
    return this.requiredPage().evaluate(() => {
      const node = (
        window as unknown as {
          libp2p: {
            peerId: unknown
            getMultiaddrs: () => unknown[]
            getConnections: () => { remotePeer: unknown; remoteAddr: unknown }[]
          }
        }
      ).libp2p
      return {
        peerId: String(node.peerId),
        multiaddrs: node.getMultiaddrs().map(String),
        connections: node.getConnections().map(({ remotePeer, remoteAddr }) => ({
          remotePeer: String(remotePeer),
          remoteAddr: String(remoteAddr),
        })),
      }
    })
  }

  async close() {
    await this.context?.close()
  }

  private requiredPage() {
    if (!this.page) throw new Error(`${this.name} is not open`)
    return this.page
  }
}

async function deleteProvisionedRelay(
  page: Page,
  instanceName: string,
  instanceHash: string,
  account: ReturnType<typeof privateKeyToAccount>,
) {
  await page
    .getByRole('button', { name: 'Refresh' })
    .click()
    .catch(() => {})
  const instance = page.locator('details').filter({ hasText: instanceName }).first()
  await instance.waitFor({ state: 'visible', timeout: 60_000 })
  await instance.getByRole('button', { name: 'Delete', exact: true }).click()
  let deletionSummary: string
  try {
    deletionSummary = await waitForAlephInstanceDeletion(instanceHash, UI_DELETE_GRACE_PERIOD)
  } catch {
    deletionSummary = `Direct awaited fallback: ${await cleanupAlephInstance(account, instanceHash, false)}`
  }
  await page
    .getByRole('button', { name: 'Refresh' })
    .click()
    .catch(() => {})
  await expect(page.locator('details').filter({ hasText: instanceName })).toHaveCount(0, { timeout: 60_000 })
  return deletionSummary
}

test.describe('React Relay Button chat', () => {
  test.skip(!PRIVATE_KEY, 'RELAY_BUTTON_E2E_PRIVATE_KEY is required to provision an Aleph relay')
  test.skip(!SSH_PUBLIC_KEY, 'RELAY_BUTTON_E2E_SSH_PUBLIC_KEY is required to provision an Aleph relay')
  test.setTimeout(45 * 60_000)

  test('provisions a uc-go-peer and exchanges chat messages through it in two browsers', async ({ browser }) => {
    await mkdir(OUTPUT_DIR, { recursive: true })
    const account = privateKeyToAccount(
      PRIVATE_KEY!.startsWith('0x') ? (PRIVATE_KEY as `0x${string}`) : `0x${PRIVATE_KEY}`,
    )
    const instanceName = `uc-chat-e2e-${Date.now()}`
    const startedAt = Date.now()
    const deploymentContext = await browser.newContext()
    await installWalletProvider(deploymentContext, account)
    const deploymentPage = await deploymentContext.newPage()
    const agentA = new ChatBrowserAgent('browser-a', browser)
    const agentB = new ChatBrowserAgent('browser-b', browser)
    let deployed = false
    let instanceHash: string | null = null
    let currentStep = 'preflightCleanup'
    let testError: Error | null = null
    let cleanupError: Error | null = null
    const steps: Record<string, EvidenceStep> = {
      preflightCleanup: { label: 'Previously leaked E2E instances deleted', status: 'pending' },
      walletAndManifest: { label: 'Wallet connected and uc-go-peer manifest accepted', status: 'pending' },
      instanceProvisioned: { label: 'Aleph uc-go-peer VM provisioned', status: 'pending' },
      bootstrapPublished: { label: 'New peer published browser WSS addresses', status: 'pending' },
      browserAConnected: { label: 'Browser A connected to the new peer', status: 'pending' },
      browserBConnected: { label: 'Browser B connected to the new peer', status: 'pending' },
      messageAToB: { label: 'Public chat message travelled A → B', status: 'pending' },
      messageBToA: { label: 'Public chat message travelled B → A', status: 'pending' },
      cleanup: { label: 'Temporary Aleph instance deleted', status: 'pending' },
    }
    const evidence: Record<string, unknown> = {
      instanceName,
      ownerAddress: account.address,
      startedAt: new Date(startedAt).toISOString(),
      steps,
    }
    const pass = (step: string, detail = '') => {
      steps[step] = { ...steps[step], status: 'passed', detail }
    }

    try {
      if (CLEANUP_INSTANCE_HASHES.length > 0) {
        const cleanupSummaries = await Promise.all(
          CLEANUP_INSTANCE_HASHES.map((hash) => cleanupAlephInstance(account, hash, true)),
        )
        pass('preflightCleanup', cleanupSummaries.join('\n'))
      } else {
        steps.preflightCleanup = { ...steps.preflightCleanup, status: 'skipped', detail: 'No cleanup input supplied' }
      }

      currentStep = 'walletAndManifest'
      await deploymentPage.goto(APP_URL, { waitUntil: 'domcontentloaded' })
      const relayLauncher = deploymentPage.getByRole('button', {
        name: /(?:Sponsor Relay|Relay Button|Relay)/,
      })
      await expect(relayLauncher).toBeVisible({ timeout: 60_000 })
      await relayLauncher.click()
      // The React relay component currently exposes placeholders rather than
      // associated labels for these fields.
      await deploymentPage.getByPlaceholder('Instance name').fill(instanceName)
      await deploymentPage.getByText('Advanced', { exact: true }).click()
      await deploymentPage.getByPlaceholder('SSH public key').fill(SSH_PUBLIC_KEY!)
      const connectWalletButton = deploymentPage.getByRole('button', { name: 'Connect MetaMask', exact: true })
      await expect(connectWalletButton).toBeVisible()
      await connectWalletButton.click()
      const deployButton = deploymentPage.getByRole('button', { name: 'Deploy Relay' })
      await waitForDeployableManifest(deploymentPage)
      await expect(deployButton).toBeEnabled()
      pass('walletAndManifest')
      currentStep = 'instanceProvisioned'
      await deployButton.click()
      deployed = true

      const deployment = await waitForDeploymentInstance(deploymentPage, instanceName, account.address, startedAt)
      instanceHash = deployment.instanceHash
      evidence.instanceHash = instanceHash
      pass('instanceProvisioned', instanceHash)

      currentStep = 'bootstrapPublished'
      const registration = await waitForBootstrapRegistration(account.address, instanceName, startedAt)
      const content = registration.content as BootstrapContent
      const relayPeerId = content.peerId
      if (!relayPeerId) throw new Error('Bootstrap registration did not include a peer ID')
      const addresses = selectBrowserRelayAddresses(content)
      expect(
        addresses,
        'new uc-go-peer must advertise browser-dialable WebTransport, WebRTC Direct, or WSS',
      ).not.toHaveLength(0)
      evidence.registration = registration
      evidence.relayAddresses = addresses
      pass('bootstrapPublished', `${relayPeerId}: ${addresses.join(', ')}`)

      currentStep = 'browserAConnected'
      await Promise.all([agentA.open(), agentB.open()])
      const connectionA = await agentA.connectToRelay(addresses, relayPeerId)
      pass('browserAConnected', connectionA.address)
      currentStep = 'browserBConnected'
      const connectionB = await agentB.connectToRelay(addresses, relayPeerId)
      pass('browserBConnected', connectionB.address)
      evidence.relayConnections = { browserA: connectionA, browserB: connectionB }

      const messageA = `${instanceName}-from-a`
      const messageB = `${instanceName}-from-b`
      currentStep = 'messageAToB'
      await agentA.sendMessage(messageA)
      await agentB.waitForMessage(messageA)
      pass('messageAToB', messageA)
      currentStep = 'messageBToA'
      await agentB.sendMessage(messageB)
      await agentA.waitForMessage(messageB)
      pass('messageBToA', messageB)

      evidence.final = { browserA: await agentA.diagnostics(), browserB: await agentB.diagnostics() }
      await Promise.all([
        agentA.screenshot(`${OUTPUT_DIR}/browser-a.png`),
        agentB.screenshot(`${OUTPUT_DIR}/browser-b.png`),
        deploymentPage.screenshot({ path: `${OUTPUT_DIR}/relay-panel.png`, fullPage: true }),
      ])
    } catch (error) {
      testError = error instanceof Error ? error : new Error(String(error))
      if (steps[currentStep]?.status === 'pending') {
        steps[currentStep] = { ...steps[currentStep], status: 'failed', detail: testError.message }
      }
      evidence.error = testError.message
      await Promise.allSettled([
        agentA.screenshot(`${OUTPUT_DIR}/browser-a-error.png`),
        agentB.screenshot(`${OUTPUT_DIR}/browser-b-error.png`),
        deploymentPage.screenshot({ path: `${OUTPUT_DIR}/relay-panel-error.png`, fullPage: true }),
      ])
    }

    await Promise.allSettled([agentA.close(), agentB.close()])
    if (deployed) {
      try {
        instanceHash ??= await findAlephInstanceHash(account.address, instanceName, startedAt)
        evidence.instanceHash = instanceHash
        const deletionSummary = await deleteProvisionedRelay(deploymentPage, instanceName, instanceHash, account)
        pass('cleanup', deletionSummary)
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error))
        steps.cleanup = { ...steps.cleanup, status: 'failed', detail: cleanupError.message }
      }
    } else {
      steps.cleanup = { ...steps.cleanup, status: 'skipped', detail: 'No VM was submitted' }
    }

    evidence.finishedAt = new Date().toISOString()
    await writeFile(`${OUTPUT_DIR}/result.json`, `${JSON.stringify(evidence, null, 2)}\n`)
    await deploymentContext.close()
    if (cleanupError) throw cleanupError
    if (testError) throw testError
  })
})
