// DeepSeek relay bundle plugin.
//
// Reads a thin config file (default $DSH_HOME/deepseek-relay.config.yaml) and
// registers one official `DeepSeekAdapter` route per configured supplier, each
// pointing at that supplier's baseURL. The same official model may appear under
// several suppliers (each with its own baseURL / key / relayId): the llm
// service keys every selection by (provider, model), so duplicate model ids
// across provider groups are safe and resolve to their owning supplier. The
// official three model parameter sets (contextWindow / inputModalities / image
// budgets / reasoning / maxTokens / image Files-API budgets) live here — the
// config file never declares them.

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
export const OFFICIAL = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
export const OFFICIAL_MODELS = {
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
	/**
	 * Both `DeepSeekAdapter.stream(...)` and the `prepareCall()`-bound stream
	 * funnel through `streamWithConnection(options, connection)`, so a single
	 * override here sanitizes every harness-facing chunk stream.
	 */
	async *streamWithConnection(options, connection) {
		for await (const chunk of sanitizeToolCallChunks(super.streamWithConnection(options, connection))) {
			yield chunk
		}
	}
}

/**
 * Streaming sanitizer for the tool-call chunk path.
 *
 * Some relay gateways (newapi-style custom channels) stream tool-call deltas
 * whose continuation chunks repeat `"id": null` / `"name": null` (or empty
 * strings) instead of omitting the keys. The official adapter's translate()
 * guards those fields with `!== void 0`, so a null/"" delta OVERWRITES the
 * first chunk's real id/name, and the harness ends up dispatching a tool call
 * with an empty name (`unknown tool ""`).
 *
 * Remember the first non-empty id/name per tool-call block and use them to
 * REPAIR only values the adapter corrupted (present-but-empty/null). Chunks
 * whose keys are simply absent (the official DeepSeek / ginka style) pass
 * through byte-for-byte unchanged — nothing here invents data.
 *
 * @param source - the adapter's chunk stream (async iterable).
 * @returns the sanitized chunk stream.
 */
export async function* sanitizeToolCallChunks(source) {
	const first = new Map()
	for await (const chunk of source) {
		if (chunk.type === 'tool-call-delta') {
			const kept = first.get(chunk.index) ?? {}
			if (typeof chunk.id === 'string' && chunk.id.length > 0) kept.id = chunk.id
			if (typeof chunk.name === 'string' && chunk.name.length > 0) kept.name = chunk.name
			first.set(chunk.index, kept)
			let delta = chunk
			if (kept.id !== undefined && (delta.id === null || delta.id === '')) delta = { ...delta, id: kept.id }
			if (kept.name !== undefined && (delta.name === null || delta.name === '')) delta = { ...delta, name: kept.name }
			yield delta
		} else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
			const kept = first.get(chunk.index) ?? {}
			first.delete(chunk.index)
			const block = { ...chunk.block }
			if (kept.id !== undefined && (block.id === null || block.id === '')) block.id = kept.id
			if (kept.name !== undefined && (block.name === null || block.name === '')) block.name = kept.name
			yield { ...chunk, block }
		} else {
			yield chunk
		}
	}
}

export { RelayAdapter }

/** Validate + normalize the relay config. Throws a descriptive error (loud fail). */
export function normalizeConfig(doc) {
	const cfg = (doc && typeof doc === 'object' && doc.relay) || doc || {}
	const providers = cfg.providers ?? []

	const seenProviders = new Set()
	let total = 0
	for (const p of providers) {
		if (!p || typeof p !== 'object') throw new Error('a provider entry is not an object')
		if (!p.provider) throw new Error('a provider entry is missing "provider"')
		if (p.provider === 'deepseek-official') throw new Error(`provider name "deepseek-official" is reserved by the built-in DeepSeek adapter; pick another name`)
		if (seenProviders.has(p.provider)) throw new Error(`provider "${p.provider}" is configured more than once`)
		seenProviders.add(p.provider)
		const models = p.models ?? []
		if (models.length === 0) throw new Error(`provider "${p.provider}" has no models`)
		const hasKey = p.apiKey !== undefined
		const hasEnv = p.apiKeyEnv !== undefined
		if (hasKey && hasEnv) throw new Error(`provider "${p.provider}" must set only one of apiKey / apiKeyEnv`)
		if (!hasKey && !hasEnv) throw new Error(`provider "${p.provider}" needs apiKey or apiKeyEnv`)
		const seenModels = new Set()
		const seenRelayIds = new Set()
		for (const m of models) {
			total += 1
			if (!m || !m.official) throw new Error(`provider "${p.provider}": a model entry is missing "official"`)
			if (!OFFICIAL.includes(m.official)) throw new Error(`provider "${p.provider}": official model "${m.official}" is not one of ${OFFICIAL.join(', ')}`)
			if (seenModels.has(m.official)) throw new Error(`provider "${p.provider}": official model "${m.official}" is configured more than once`)
			seenModels.add(m.official)
			const relayId = m.relayId || m.official
			if (seenRelayIds.has(relayId)) throw new Error(`provider "${p.provider}": relayId "${relayId}" is used by more than one model`)
			seenRelayIds.add(relayId)
		}
	}
	if (providers.length === 0) throw new Error('no providers configured')
	if (total === 0) throw new Error('no models configured')

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
