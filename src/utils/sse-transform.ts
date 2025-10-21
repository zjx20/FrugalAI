/**
 * Creates a TransformStream that removes empty finish_reason fields from SSE responses.
 * This is useful for backends that return finish_reason: "" in streaming responses,
 * which some clients incorrectly interpret as the end of the stream.
 */
export function createFinishReasonRemovalTransform(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';

	return new TransformStream({
		transform(chunk, controller) {
			// Decode the chunk and add to buffer
			buffer += decoder.decode(chunk, { stream: true });

			// Process complete lines
			const lines = buffer.split('\n');

			// Keep the last incomplete line in buffer
			buffer = lines.pop() || '';

			for (const line of lines) {
				let processedLine = line;

				// Only process lines that start with "data: " and contain JSON
				if (line.startsWith('data: ') && line.length > 6) {
					const dataContent = line.substring(6);

					// Skip special SSE messages like [DONE]
					if (dataContent === '[DONE]') {
						processedLine = line;
					} else {
						try {
							const jsonData = JSON.parse(dataContent);

							// Remove empty finish_reason from choices
							if (jsonData.choices && Array.isArray(jsonData.choices)) {
								for (const choice of jsonData.choices) {
									if (choice.finish_reason === '') {
										delete choice.finish_reason;
									}
								}
							}

							processedLine = 'data: ' + JSON.stringify(jsonData);
						} catch (e) {
							// If parsing fails, keep the original line
							processedLine = line;
						}
					}
				}

				// Enqueue the processed line with newline
				controller.enqueue(encoder.encode(processedLine + '\n'));
			}
		},

		flush(controller) {
			// Process any remaining data in buffer
			if (buffer.length > 0) {
				let processedLine = buffer;

				if (buffer.startsWith('data: ') && buffer.length > 6) {
					const dataContent = buffer.substring(6);

					if (dataContent !== '[DONE]') {
						try {
							const jsonData = JSON.parse(dataContent);

							if (jsonData.choices && Array.isArray(jsonData.choices)) {
								for (const choice of jsonData.choices) {
									if (choice.finish_reason === '') {
										delete choice.finish_reason;
									}
								}
							}

							processedLine = 'data: ' + JSON.stringify(jsonData);
						} catch (e) {
							processedLine = buffer;
						}
					}
				}

				controller.enqueue(encoder.encode(processedLine));
			}
		}
	});
}
