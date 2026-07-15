import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { privateKeyToAccount } from 'viem/accounts'
import { mkdir, writeFile } from 'node:fs/promises'

const PRIVATE_KEY = process.env.RELAY_BUTTON_E2E_PRIVATE_KEY?.trim()
const SSH_PUBLIC_KEY = process.env.RELAY_BUTTON_E2E_SSH_PUBLIC_KEY?.trim()
const APP_URL = process.env.RELAY_BUTTON_E2E_APP_URL ?? 'http://127.0.0.1:4173'
const OUTPUT_DIR = 'test-results/relay-button-chat'
const PROVISION_TIMEOUT = 20 * 60_000
const RELAY_READINESS_TIMEOUT = 8 * 60_000
const CHAT_TIMEOUT = 3 * 60_000

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

async function waitForDeploymentInstance(page: Page, instanceName: string) {
  const outcome = await page.waitForFunction(
    (expectedName) => {
      const instance = [...document.querySelectorAll('details')].find((element) =>
        element.textContent?.includes(expectedName),
      )
      if (instance) return { status: 'instance' }
      const error = document.querySelector('aside.panel .alert.error')?.textContent?.trim()
      if (error) return { status: 'error', message: error }
      return null
    },
    instanceName,
    { timeout: PROVISION_TIMEOUT, polling: 500 },
  )
  const result = await outcome.jsonValue()
  if (result?.status === 'error') throw new Error(`Relay Button deployment failed: ${result.message}`)

  const instance = page.locator('details').filter({ hasText: instanceName }).first()
  const apiHref = await instance.getByRole('link', { name: 'API', exact: true }).getAttribute('href')
  const instanceHash = apiHref?.match(/\/messages\/([^/?#]+)/)?.[1]
  if (!instanceHash) throw new Error(`Could not read Aleph instance hash for ${instanceName}`)
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

async function waitForBootstrapRegistration(ownerAddress: string, instanceHash: string, startedAt: number) {
  // The package exposes an ESM-only entry point. Dynamic import keeps this
  // compatible with Playwright's CommonJS transform in this Next.js app.
  const { DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE, DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE, fetchAlephBootstrapPosts } =
    await import('@le-space/aleph-bootstrap')

  const deadline = Date.now() + PROVISION_TIMEOUT
  let lastSummary = 'No bootstrap posts returned.'

  while (Date.now() < deadline) {
    const posts = (
      await Promise.all(
        [DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE, DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE].map((postType) =>
          fetchAlephBootstrapPosts({ pagination: 200, postType }),
        ),
      ).catch((error) => {
        lastSummary = error instanceof Error ? error.message : String(error)
        return []
      })
    ).flat()

    const registration = posts.find(({ address, content }) => {
      const candidate = content as BootstrapContent
      const owner = (candidate.ownerAddress ?? candidate.publisherAddress ?? address)?.toLowerCase()
      const addresses = candidate.browserMultiaddrs?.length ? candidate.browserMultiaddrs : candidate.multiaddrs
      return (
        owner === ownerAddress.toLowerCase() &&
        candidate.registrationId?.includes(instanceHash) &&
        Number(candidate.updatedAt ?? 0) >= startedAt - 60_000 &&
        (addresses?.length ?? 0) > 0
      )
    })
    if (registration) return registration
    lastSummary = `${posts.length} posts checked; no current registration for ${instanceHash}`
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }

  throw new Error(`Relay bootstrap registration timed out: ${lastSummary}`)
}

function selectBrowserRelayAddresses(content: BootstrapContent) {
  const addresses = content.browserMultiaddrs?.length ? content.browserMultiaddrs : (content.multiaddrs ?? [])
  return addresses
    .filter((address) => /\/(tls\/ws|wss)\/p2p\//.test(address))
    .sort((left, right) => {
      const rank = (address: string) => (address.includes('.libp2p.direct/') ? 0 : address.includes('.2n6.me/') ? 1 : 2)
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
    await this.waitForMessage(message)
  }

  async waitForMessage(message: string) {
    await this.requiredPage().getByText(message, { exact: true }).waitFor({ state: 'visible', timeout: CHAT_TIMEOUT })
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

async function deleteProvisionedRelay(page: Page, instanceName: string) {
  await page
    .getByRole('button', { name: 'Refresh' })
    .click()
    .catch(() => {})
  const instance = page.locator('details').filter({ hasText: instanceName }).first()
  await instance.waitFor({ state: 'visible', timeout: 60_000 })
  await instance.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(instance).toBeHidden({ timeout: 3 * 60_000 })
}

test.describe('React Relay Button chat', () => {
  test.skip(!PRIVATE_KEY, 'RELAY_BUTTON_E2E_PRIVATE_KEY is required to provision an Aleph relay')
  test.skip(!SSH_PUBLIC_KEY, 'RELAY_BUTTON_E2E_SSH_PUBLIC_KEY is required to provision an Aleph relay')
  test.setTimeout(30 * 60_000)

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
    let testError: Error | null = null
    let cleanupError: Error | null = null
    const steps: Record<string, EvidenceStep> = {
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
      await deploymentPage.goto(APP_URL, { waitUntil: 'domcontentloaded' })
      const relayLauncher = deploymentPage.getByRole('button', {
        name: /^(?:Sponsor Relay|Relay Button|Relay)$/,
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
      await deployButton.click()

      const { instanceHash } = await waitForDeploymentInstance(deploymentPage, instanceName)
      deployed = true
      evidence.instanceHash = instanceHash
      pass('instanceProvisioned', instanceHash)

      const registration = await waitForBootstrapRegistration(account.address, instanceHash, startedAt)
      const content = registration.content as BootstrapContent
      const relayPeerId = content.peerId
      if (!relayPeerId) throw new Error('Bootstrap registration did not include a peer ID')
      const addresses = selectBrowserRelayAddresses(content)
      expect(addresses, 'new uc-go-peer must advertise browser-reachable WSS').not.toHaveLength(0)
      evidence.registration = registration
      evidence.relayAddresses = addresses
      pass('bootstrapPublished', `${relayPeerId}: ${addresses.join(', ')}`)

      await Promise.all([agentA.open(), agentB.open()])
      const [connectionA, connectionB] = await Promise.all([
        agentA.connectToRelay(addresses, relayPeerId),
        agentB.connectToRelay(addresses, relayPeerId),
      ])
      evidence.relayConnections = { browserA: connectionA, browserB: connectionB }
      pass('browserAConnected', connectionA.address)
      pass('browserBConnected', connectionB.address)

      const messageA = `${instanceName}-from-a`
      const messageB = `${instanceName}-from-b`
      await agentA.sendMessage(messageA)
      await agentB.waitForMessage(messageA)
      pass('messageAToB', messageA)
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
        await deleteProvisionedRelay(deploymentPage, instanceName)
        pass('cleanup')
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
