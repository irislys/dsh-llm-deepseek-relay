// Config-conflict verification suite for dsh-llm-deepseek-relay.
//
// Verifies, under complex multi-provider configs:
//   - legal shapes load (incl. same model under many suppliers, same relayId
//     across suppliers, ids that coincide with other namespaces)
//   - illegal shapes fail loud with a precise message
//   - the real dsh llm registration rule (provider-name namespace, NOT model
//     ids) is exercised against a real LlmRuntime, not a hand-rolled mock
//
// Run: node --test test/   (needs the @deepseek-ai/* and js-yaml deps on disk)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { normalizeConfig, OFFICIAL_MODELS } from '../lib/index.js'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'

/** Replicates the catalog mapping the plugin uses for one provider's adapter options. */
const catalog = (p) => p.models.map((m) => ({ id: m.relayId, ...OFFICIAL_MODELS[m.official] }))

/** Minimal cordis-shaped ctx sufficient for a real LlmRuntime registration. */
function minimalCtx() {
	const services = new Map()
	return {
		logger: { warn: () => {} },
		events: { dispatch: () => [] },
		reflect: {
			provide: (name, instance) => { services.set(name, instance) },
		},
		effect(generator) {
			const it = generator()
			let disposer = () => {}
			const step = (arg) => {
				const result = it.next(arg)
				if (result.done) return disposer
				if (typeof result.value === 'function') disposer = result.value
				return step(result.value)
			}
			step(undefined)
			return () => disposer()
		},
	}
}

function mockAdapter(models = []) {
	return {
		providerInfo: (p) => ({ id: p, name: p }),
		providerRetryPolicy: () => undefined,
		listModels: async (p) => models.map((m) => ({
			provider: p,
			id: m.id,
			name: m.name ?? m.id,
			...(m.inputModalities === undefined ? {} : { inputModalities: [...m.inputModalities] }),
		})),
	}
}

const throws = (fn, pattern) => {
	let caught
	try {
		fn()
	} catch (error) {
		caught = error
	}
	assert.ok(caught, 'expected a throw, got none')
	if (pattern !== undefined) assert.match(caught.message, pattern)
	return caught
}

// ── legal shapes ────────────────────────────────────────────────────────────

test('complex config: same official model under 3 suppliers, relays and ids interleaved', () => {
	const out = normalizeConfig({
		providers: [
			{ provider: 'relay-a', baseURL: 'https://a/v1', apiKeyEnv: 'KA', models: [
				{ official: 'deepseek-v4-flash', relayId: 'flash-a' },
				{ official: 'deepseek-v4-flash-vision-exp', relayId: 'shared-x' },
			] },
			{ provider: 'relay-b', baseURL: 'https://b/v1', apiKey: 'sk-b', models: [
				{ official: 'deepseek-v4-flash', relayId: 'flash-b' },
				{ official: 'deepseek-v4-pro', relayId: 'pro-b' },
			] },
			{ provider: 'relay-c', baseURL: 'https://c/v1', apiKeyEnv: 'KC', models: [
				{ official: 'deepseek-v4-flash', relayId: 'flash-c' },
				{ official: 'deepseek-v4-flash-vision-exp', relayId: 'shared-x' },
			] },
			{ provider: 'relay-d', baseURL: 'https://d/v1', apiKeyEnv: 'KD', models: [
				{ official: 'deepseek-v4-flash' },
			] },
		],
	})
	assert.equal(out.providers.length, 4)
	assert.equal(out.providers[3].models[0].relayId, 'deepseek-v4-flash') // defaults to official
})

test('parameter parity: same relayId across providers carries each provider\'s own official params', () => {
	const out = normalizeConfig({
		providers: [
			{ provider: 'relay-text', baseURL: 'https://t/v1', apiKey: 'sk', models: [
				{ official: 'deepseek-v4-flash', relayId: 'same-id' },
			] },
			{ provider: 'relay-vision', baseURL: 'https://v/v1', apiKey: 'sk', models: [
				{ official: 'deepseek-v4-flash-vision-exp', relayId: 'same-id' },
			] },
		],
	})
	const text = catalog(out.providers[0]).find((m) => m.id === 'same-id')
	const vision = catalog(out.providers[1]).find((m) => m.id === 'same-id')
	assert.deepEqual(text.inputModalities, ['text'])
	assert.deepEqual(vision.inputModalities, ['text', 'image'])
	assert.ok(vision.imagePixelBudget !== undefined && text.imagePixelBudget === undefined)
})

test('model-id and provider-name namespaces do not collide', () => {
	const out = normalizeConfig({
		providers: [
			{ provider: 'deepseek-v4-pro', baseURL: 'https://p/v1', apiKey: 'sk', models: [
				{ official: 'deepseek-v4-pro' },
				{ official: 'deepseek-v4-flash', relayId: 'deepseek-official' }, // model id == another provider's name
			] },
			{ provider: 'relay-b', baseURL: 'https://b/v1', apiKey: 'sk', models: [
				{ official: 'deepseek-v4-flash', relayId: 'deepseek-v4-pro' }, // model id == another provider's name
			] },
		],
	})
	assert.equal(out.providers[0].provider, 'deepseek-v4-pro')
})

test('cross-provider identical default relayIds are legal', () => {
	normalizeConfig({
		providers: [
			{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash' }] },
			{ provider: 'b', baseURL: 'https://b/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash' }] },
		],
	})
})

test('backward compatible: old-style single/multi-provider configs without overlap still load', () => {
	normalizeConfig({
		providers: [
			{ provider: 'deepseek-a', baseURL: 'https://a/v1', apiKey: 'sk', models: [
				{ official: 'deepseek-v4-flash' },
				{ official: 'deepseek-v4-pro' },
				{ official: 'deepseek-v4-flash-vision-exp' },
			] },
		],
	})
	const out = normalizeConfig({ relay: { providers: [
		{ provider: 'x', baseURL: 'https://x/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash' }] },
		{ provider: 'y', baseURL: 'https://y/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-pro' }] },
	] } })
	assert.equal(out.providers[1].models[0].relayId, 'deepseek-v4-pro')
})

test('shipped sample config file and README inline example both validate', () => {
	const sample = yaml.load(readFileSync(new URL('../deepseek-relay.config.yaml', import.meta.url), 'utf8'))
	const out = normalizeConfig(sample)
	assert.equal(out.providers.length, 2)
	assert.deepEqual(out.providers[0].models.map((m) => m.relayId), ['deepseek-v4-flash-0731', 'dsv4fve'])

	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
	const block = /```yaml\n([\s\S]*?)```/.exec(readme)
	assert.ok(block, 'README must contain a yaml example block')
	normalizeConfig(yaml.load(block[1]))
})

// ── illegal shapes (loud failure, precise message) ─────────────────────────

test('reserved provider name deepseek-official is rejected at load', () => {
	throws(() => normalizeConfig({
		providers: [{ provider: 'deepseek-official', baseURL: 'https://x/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash' }] }],
	}), /deepseek-official.*reserved by the built-in DeepSeek adapter/)
})

test('same official model twice inside one provider', () => {
	throws(() => normalizeConfig({
		providers: [
			{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash' }, { official: 'deepseek-v4-flash', relayId: 'x' }] },
		],
	}), /deepseek-v4-flash.*configured more than once/)
})

test('same relayId twice inside one provider', () => {
	throws(() => normalizeConfig({
		providers: [
			{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash', relayId: 'dup' }, { official: 'deepseek-v4-pro', relayId: 'dup' }] },
		],
	}), /relayId "dup" is used by more than one model/)
})

test('duplicate provider names', () => {
	throws(() => normalizeConfig({
		providers: [
			{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [{ official: 'deepseek-v4-flash' }] },
			{ provider: 'a', baseURL: 'https://a2/v1', apiKeyEnv: 'K', models: [{ official: 'deepseek-v4-pro' }] },
		],
	}), /provider "a" is configured more than once/)
})

test('structural negatives still fail loud', () => {
	throws(() => normalizeConfig({ providers: [] }), /no providers configured/)
	throws(() => normalizeConfig({
		providers: [{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [{ official: 'deepseek-v5' }] }],
	}), /is not one of/)
	throws(() => normalizeConfig({
		providers: [{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', apiKeyEnv: 'K', models: [{ official: 'deepseek-v4-flash' }] }],
	}), /must set only one of apiKey \/ apiKeyEnv/)
	throws(() => normalizeConfig({
		providers: [{ provider: 'a', baseURL: 'https://a/v1', models: [{ official: 'deepseek-v4-flash' }] }],
	}), /needs apiKey or apiKeyEnv/)
	throws(() => normalizeConfig({
		providers: [{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [{ relayId: 'x' }] }],
	}), /missing "official"/)
	throws(() => normalizeConfig({
		providers: [{ provider: 'a', baseURL: 'https://a/v1', apiKey: 'sk', models: [] }],
	}), /has no models/)
})

// ── registration-level rules against the REAL dsh llm service ──────────────

test('real LlmRuntime: provider-name namespace is the only conflict axis (DUPLICATE_ADAPTER)', () => {
	const runtime = new LlmRuntime(minimalCtx())
	runtime.registerAdapter(['deepseek-official'], mockAdapter([])) // the built-in adapter owns this route
	const caught = throws(() => runtime.registerAdapter(['deepseek-official'], mockAdapter([])), undefined)
	assert.equal(caught.code, 'DUPLICATE_ADAPTER')
})

test('real LlmRuntime: two providers may register identical model ids side by side', async () => {
	const runtime = new LlmRuntime(minimalCtx())
	runtime.registerAdapter(['relay-a'], mockAdapter([{ id: 'shared', inputModalities: ['text'] }]))
	runtime.registerAdapter(['relay-b'], mockAdapter([{ id: 'shared', inputModalities: ['text', 'image'] }]))
	const a = await runtime.listModels('relay-a')
	const b = await runtime.listModels('relay-b')
	assert.equal(a[0].id, 'shared')
	assert.deepEqual(b[0].inputModalities, ['text', 'image'])
	assert.equal(runtime.listProviders().length, 2)

	// Corroboration: the llm service itself also refuses duplicate ids *within* one
	// provider's catalog (separate seen-set per provider, so cross-provider dupes never touch).
	const bad = new LlmRuntime(minimalCtx())
	bad.registerAdapter(['relay-x'], mockAdapter([{ id: 'dup' }, { id: 'dup' }]))
	await assert.rejects(() => bad.listModels('relay-x'), (error) => error.code === 'INVALID_CATALOG')
})