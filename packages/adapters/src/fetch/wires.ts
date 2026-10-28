import { streamAnthropicMessages } from '../anthropic.ts';
import type { WireFormat } from './catalog.ts';
import { streamOpenAICodexResponses, streamOpenAIResponses } from './openai-responses.ts';
import type { WireStream } from './wire.ts';

/**
 * 전송 형식별 스트림 함수의 등록부다.
 */
const WIRES: Partial<Record<WireFormat, WireStream>> = {
  'anthropic-messages': streamAnthropicMessages,
  'openai-responses': streamOpenAIResponses,
  'openai-codex-responses': streamOpenAICodexResponses,
};

export function getWire(format: WireFormat): WireStream | undefined {
  return WIRES[format];
}
