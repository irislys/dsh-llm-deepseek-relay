// Tool-call chunk sanitizer verification suite for dsh-llm-deepseek-relay.
//
// The sanitizer repairs the failure mode where a relay gateway streams
// tool-call continuation deltas with explicit `"id": null` / `"name": null`
// (or empty strings): the official adapter's translate() guards those fields
// with `!== void 0`, so null/"" overwrite the first chunk's real id/name and
// the harness dispatches a tool call with an empty name (`unknown tool ""`).
//
// Scenarios covered:
//   (a) newapi-style: first delta carries id/name, continuations carry null/""
//       -> every delta and the block-end keep the first non-empty values
//   (b) official/ginka-style: continuation chunks omit the keys (undefined)
//       -> the stream passes through byte-for-byte unchanged (regression guard)
//   (c) parallel tool calls (wire indices 0 and 1) keep independent identities
//   (d) non-tool chunks (reasoning/text/usage/finish) pass through untouched

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeToolCallChunks } from '../lib/index.js'

const collect = async (source) => {
	const out = []
	for await (const chunk of sanitizeToolCallChunks(source)) out.push(chunk)
	return out
}

test('(a) newapi-style null/"" continuations keep the first id and name', async () => {
	const source = [
		{ type: 'block-start', index: 7, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 7, id: 'call_abc123', name: 'bash', argumentsDelta: '' },
		{ type: 'tool-call-delta', index: 7, id: '', name: null, argumentsDelta: '{' },
		{ type: 'tool-call-delta', index: 7, id: '', name: null, argumentsDelta: '"command": "pwd"' },
		{ type: 'block-end', index: 7, block: { type: 'tool-call', id: '', name: '', arguments: '{"command": "pwd"}' } },
	]
	const out = await collect(source)
	assert.equal(out.length, 5)
	// every delta carries the remembered identity
	for (const chunk of out.slice(1, 4)) {
		assert.equal(chunk.id, 'call_abc123')
		assert.equal(chunk.name, 'bash')
	}
	// the block-end gets the identity written back
	const end = out[4]
	assert.equal(end.block.id, 'call_abc123')
	assert.equal(end.block.name, 'bash')
	assert.equal(end.block.arguments, '{"command": "pwd"}')
})

test('(b) official/ginka-style omitted keys pass through unchanged', async () => {
	const source = [
		{ type: 'block-start', index: 0, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 0, id: 'call_x', name: 'get_weather', argumentsDelta: '' },
		{ type: 'tool-call-delta', index: 0, argumentsDelta: '{"' },
		{ type: 'tool-call-delta', index: 0, argumentsDelta: 'city": "北京"}' },
		{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_x', name: 'get_weather', arguments: '{"city": "北京"}' } },
		{ type: 'usage', usage: { inputTokens: 1 } },
	]
	const out = await collect(source)
	assert.deepEqual(out, source)
})

test('(c) parallel tool calls keep independent identities per block index', async () => {
	const source = [
		{ type: 'block-start', index: 3, blockType: 'tool-call' },
		{ type: 'block-start', index: 4, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 3, id: 'call_a', name: 'read', argumentsDelta: '' },
		{ type: 'tool-call-delta', index: 4, id: 'call_b', name: 'bash', argumentsDelta: '' },
		{ type: 'tool-call-delta', index: 3, id: null, name: null, argumentsDelta: 'a' },
		{ type: 'tool-call-delta', index: 4, id: null, name: null, argumentsDelta: 'b' },
		{ type: 'tool-call-delta', index: 3, id: '', name: null, argumentsDelta: '2' },
		{ type: 'block-end', index: 4, block: { type: 'tool-call', id: '', name: '', arguments: 'b' } },
		{ type: 'block-end', index: 3, block: { type: 'tool-call', id: '', name: '', arguments: 'a2' } },
	]
	const out = await collect(source.filter((c) => c.type !== 'block-start'))
	const deltas = out.filter((c) => c.type === 'tool-call-delta')
	assert.deepEqual(deltas.map((c) => [c.index, c.id, c.name]), [
		[3, 'call_a', 'read'],
		[4, 'call_b', 'bash'],
		[3, 'call_a', 'read'],
		[4, 'call_b', 'bash'],
		[3, 'call_a', 'read'],
	])
	const ends = out.filter((c) => c.type === 'block-end')
	assert.equal(ends.find((c) => c.index === 3).block.name, 'read')
	assert.equal(ends.find((c) => c.index === 4).block.name, 'bash')
	assert.equal(ends.find((c) => c.index === 3).block.id, 'call_a')
	assert.equal(ends.find((c) => c.index === 4).block.id, 'call_b')
})

test('(d) non-tool chunks pass through untouched and the stream ends cleanly', async () => {
	const source = [
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: 'think' },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: 'hi' },
		{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
		{ type: 'block-end', index: 1, block: { type: 'text', text: 'hi' } },
		{ type: 'usage', usage: { inputTokens: 5 } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
	const out = await collect(source)
	assert.deepEqual(out, source)
})