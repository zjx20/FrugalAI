import { describe, it, expect } from 'vitest';
import { createFinishReasonRemovalTransform } from '../src/utils/sse-transform';

describe('SSE Transform', () => {
	it('should remove empty finish_reason from SSE chunks', async () => {
		const input = `data: {"id":"resp_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":""}]}

data: {"id":"resp_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":""}]}

data: {"id":"resp_1","model":"gpt-5","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}

data: [DONE]
`;

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(input));
				controller.close();
			}
		});

		const transformStream = createFinishReasonRemovalTransform();
		const transformedStream = stream.pipeThrough(transformStream);

		const reader = transformedStream.getReader();
		let result = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode(); // flush

		// Parse the results
		const lines = result.trim().split('\n').filter(line => line.trim());

		// First chunk should not have finish_reason
		const firstData = JSON.parse(lines[0].substring(6));
		expect(firstData.choices[0]).not.toHaveProperty('finish_reason');
		expect(firstData.choices[0].delta.content).toBe('hello');

		// Second chunk should not have finish_reason
		const secondData = JSON.parse(lines[1].substring(6));
		expect(secondData.choices[0]).not.toHaveProperty('finish_reason');
		expect(secondData.choices[0].delta.content).toBe(' world');

		// Third chunk should keep non-empty finish_reason
		const thirdData = JSON.parse(lines[2].substring(6));
		expect(thirdData.choices[0].finish_reason).toBe('stop');

		// [DONE] should remain unchanged
		expect(lines[3]).toBe('data: [DONE]');
	});

	it('should handle chunked streaming correctly', async () => {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		// Simulate chunks that are split mid-line
		const chunks = [
			'data: {"id":"resp_1","choices":[{"index":0,"delta":{"conte',
			'nt":"hello"},"finish_reason":""}]}\n\ndata: {"id":"resp_1",',
			'"choices":[{"index":0,"delta":{"content":" world"},"finish_',
			'reason":""}]}\n\ndata: [DONE]\n'
		];

		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			}
		});

		const transformStream = createFinishReasonRemovalTransform();
		const transformedStream = stream.pipeThrough(transformStream);

		const reader = transformedStream.getReader();
		let result = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();

		// Verify the result contains properly transformed data
		expect(result).toContain('"content":"hello"');
		expect(result).toContain('"content":" world"');
		expect(result).toContain('data: [DONE]');

		// Count occurrences of finish_reason (should be 0 since both are empty)
		const finishReasonCount = (result.match(/"finish_reason"/g) || []).length;
		expect(finishReasonCount).toBe(0);
	});

	it('should preserve valid finish_reason values', async () => {
		const input = `data: {"id":"resp_1","choices":[{"index":0,"delta":{"content":"test"},"finish_reason":"length"}]}

data: {"id":"resp_1","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}
`;

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(input));
				controller.close();
			}
		});

		const transformStream = createFinishReasonRemovalTransform();
		const transformedStream = stream.pipeThrough(transformStream);

		const reader = transformedStream.getReader();
		let result = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();

		// Both finish_reason values should be preserved
		expect(result).toContain('"finish_reason":"length"');
		expect(result).toContain('"finish_reason":"stop"');
	});

	it('should handle invalid JSON gracefully', async () => {
		const input = `data: {"invalid json

data: {"id":"resp_1","choices":[{"index":0,"delta":{"content":"test"},"finish_reason":""}]}

data: [DONE]
`;

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(input));
				controller.close();
			}
		});

		const transformStream = createFinishReasonRemovalTransform();
		const transformedStream = stream.pipeThrough(transformStream);

		const reader = transformedStream.getReader();
		let result = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();

		// Invalid JSON should be preserved as-is
		expect(result).toContain('data: {"invalid json');

		// Valid chunk should be transformed
		expect(result).toContain('"content":"test"');
		expect(result).not.toContain('"finish_reason":""');

		// [DONE] should remain
		expect(result).toContain('data: [DONE]');
	});
});
