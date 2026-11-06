import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  createCapabilityToken,
  httpStatusHintOf,
  AgentRunNotFoundError,
  AgentRunStateError,
  AgentRunApprovalError,
  AgentRunDefinitionError,
  AgentRunLeaseLostError,
  AgentRunStoreUnavailableError,
} from '../../src/index.ts';

describe('agent run contracts', () => {
  it('uses a legal capability and masked status hints', () => {
    expect(createCapabilityToken(CAPABILITIES.AGENT_RUNS)).toBe('agent-runs');
    for (const [error, status] of [
      [new AgentRunNotFoundError(), 404],
      [new AgentRunStateError(), 409],
      [new AgentRunStateError(413), 413],
      [new AgentRunApprovalError(), 409],
      [new AgentRunApprovalError(403), 403],
      [new AgentRunStoreUnavailableError('secret', { cause: new Error('private') }), 503],
    ] as const) {
      expect(error.name).toBe(error.constructor.name);
      expect(httpStatusHintOf(error)?.status).toBe(status);
      expect(JSON.stringify(httpStatusHintOf(error))).not.toMatch(/secret|private/);
    }
    for (const error of [new AgentRunDefinitionError(), new AgentRunLeaseLostError()]) {
      expect(error.name).toBe(error.constructor.name);
      expect(httpStatusHintOf(error)).toBeUndefined();
    }
    expect(new AgentRunDefinitionError('configuration').message).toBe('configuration');
  });
});
