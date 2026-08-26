// DeepSeek relay bundle plugin.
//
// Reads a thin config file (default $DSH_HOME/deepseek-relay.config.yaml) and
// registers one official `DeepSeekAdapter` route per configured supplier, each
// pointing at that supplier's baseURL. The official three model parameter sets
// (contextWindow / inputModalities / image budgets / reasoning / maxTokens /
// image Files-API budgets) live here — the config file never declares them.

import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import yaml from 'js-yaml'
import { readFileSync, watchFile } from 'node:fs'
import { join } from 'node:path'

export const name = 'llm-deepseek-relay'

export const inject = ['llm']

export const Config = z.object({
	configPath: z.string().default(''),
})

/** The official DeepSeek models and their immutable parameter sets. */
const OFFICIAL = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
const OFFICIAL_MODELS = {
	'deepseek-v4-flash': { contextWindow: 1000000, inputModalities: ['text'] },
	'deepseek-v4-pro': { contextWindow: 1000000, inputModalities: ['text'] },
	'deepseek-v4-flash-vision-exp': {
		contextWindow: 1000000,
		inputModalities: ['text', 'image'],
		imagePixelBudget: 640000,
		imageMaxBytes: 1048576,
	},
}
// Adapter-level defaults, mirroring the official adapter (kept out of config).
const DEFAULT_MAX_TOKENS = 256000
const DEFAULT_CONTEXT_WINDOW = 1000000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000

/**
 * A DeepSeekAdapter whose provider route shows the supplier's own name in the
 * model picker, instead of the hardcoded "DeepSeek" the base adapter returns.
 */
class RelayAdapter extends DeepSeekAdapter {
	constructor(options, displayName) {
		super(options)
		this._displayName = displayName
	}
	providerInfo(provider) {
		return { id: provider, name: this._displayName }
	}
}

/** Validate + normalize the relay config. Throws a descriptive error (loud fail). */
function normalizeConfig(doc) {
	const cfg = (doc && typeof doc === 'object' && doc.relay) || doc || {}
	const providers = cfg.providers ?? []

	const seen = new Set()
	let total = 0
	for (const p of providers) {
		if (!p || typeof p !== 'object') throw new Error('a provider entry is not an object')
		if (!p.provider) throw new Error('a provider entry is missing "provider"')
		const models = p.models ?? []
		if (models.length === 0) throw new Error(`provider "${p.provider}" has no models`)
		const hasKey = p.apiKey !== undefined
		const hasEnv = p.apiKeyEnv !== undefined
		if (hasKey && hasEnv) throw new Error(`provider "${p.provider}" must set only one of apiKey / apiKeyEnv`)
		if (!hasKey && !hasEnv) throw new Error(`provider "${p.provider}" needs apiKey or apiKeyEnv`)
		for (const m of models) {
			total += 1
			if (!m || !m.official) throw new Error(`provider "${p.provider}": a model entry is missing "official"`)
			if (!OFFICIAL.includes(m.official)) throw new Error(`provider "${p.provider}": official model "${m.official}" is not one of ${OFFICIAL.join(', ')}`)
			if (seen.has(m.official)) throw new Error(`official model "${m.official}" is configured more than once`)
			seen.add(m.official)
		}
	}
	if (providers.length === 0) throw new Error('no providers configured')
	if (total === 0) throw new Error('no models configured')
	if (total > 3) throw new Error(`too many models (${total}); at most 3`)

	return {
		providers: providers.map((p) => ({
			provider: p.provider,
			displayName: p.displayName || p.provider,
			baseURL: p.baseURL,
			apiKey: p.apiKey,
			apiKeyEnv: p.apiKeyEnv,
			models: p.models.map((m) => ({
				official: m.official,
				relayId: m.relayId || m.official,
			})),
		})),
	}
}

function readConfig(path) {
	const text = readFileSync(path, 'utf8')
	const doc = yaml.load(text)
	return normalizeConfig(doc)
}

export function apply(ctx, pluginConfig) {
	const configPath = pluginConfig.configPath || join(resolveDshHome(), 'deepseek-relay.config.yaml')
	const environment = launchEnvironmentOf(ctx)

	// currentDoc is the live, validated config. Re-read on file change; keep last
	// good on a malformed edit (so a bad save never half-breaks a running system).
	let currentDoc = readConfig(configPath) // throws → loud fail at load

	watchFile(configPath, { interval: 2000 }, () => {
		try {
			currentDoc = readConfig(configPath)
			ctx.logger?.info?.('llm-deepseek-relay: reloaded relay config')
		} catch (error) {
			ctx.logger?.error?.('llm-deepseek-relay: keeping last good config', error)
		}
	})

	const providerEntry = (name) => currentDoc.providers.find((p) => p.provider === name)

	// Register one adapter per supplier. A supplier's baseURL / models / key are
	// read from the live doc on every operation, so config edits apply to the
	// next request without re-registration (provider topology changes need restart).
	for (const p of currentDoc.providers) {
		const adapterOptions = () => {
			const live = providerEntry(p.provider)
			const catalog = live.models.map((m) => ({ id: m.relayId, ...OFFICIAL_MODELS[m.official] }))
			return resolveAdapterOptions(
				{
					baseURL: live.baseURL,
					models: catalog,
					maxTokens: DEFAULT_MAX_TOKENS,
					defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
					streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
				},
				environment,
			)
		}

		const resolveApiKey = async () => {
			const live = providerEntry(p.provider)
			if (live.apiKey !== undefined) return assertUsableApiKey(live.apiKey, `llm-deepseek-relay/${live.provider}`, 'apiKey')
			const ref = credentialRef(live.apiKeyEnv)
			const credentials = ctx.get('credentials')
			if (credentials !== undefined) {
				const hit = await credentials.resolve(ref)
				if (hit !== undefined) return assertUsableApiKey(hit.value, `llm-deepseek-relay/${live.provider}`, ref)
			}
			const ambient = environment.get(live.apiKeyEnv)?.value
			if (ambient !== undefined && ambient.length > 0) return assertUsableApiKey(ambient, `llm-deepseek-relay/${live.provider}`, ref)
			throw new LlmError(`llm-deepseek-relay: no API key for provider route "${live.provider}"; set apiKey or provide ${live.apiKeyEnv}`, 'MISSING_CREDENTIAL')
		}

		let userId
		const adapter = new RelayAdapter(
			{
				options: adapterOptions,
				resolveApiKey,
				resolveUserId: () => (userId ??= getOrCreateAnonymousUserId()),
				resolveAttachments: () => ctx.get('attachments'),
			},
			p.displayName,
		)

		ctx.llm.registerAdapter([p.provider], adapter)
	}
}
