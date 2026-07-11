export type ProviderReservationReplayGateStatus = "idle" | "pending" | "complete";

export interface ProviderReservationReplayGateState {
  readonly generation: number;
  readonly payloadKey: string | null;
  readonly status: ProviderReservationReplayGateStatus;
}

export interface ProviderReservationReplayGateDecision {
  readonly state: ProviderReservationReplayGateState;
  readonly accepted: boolean;
  readonly generation: number;
}

export function createProviderReservationReplayGateState(): ProviderReservationReplayGateState {
  return { generation: 0, payloadKey: null, status: "idle" };
}

/** Accept a new exact payload or reject a replay of the pending/completed payload. */
export function beginProviderReservationReplay(
  state: ProviderReservationReplayGateState,
  payloadKey: string,
): ProviderReservationReplayGateDecision {
  if (state.status !== "idle" && state.payloadKey === payloadKey) {
    return { state, accepted: false, generation: state.generation };
  }

  const generation = state.generation + 1;
  return {
    state: { generation, payloadKey, status: "pending" },
    accepted: true,
    generation,
  };
}

/** Complete only the current generation; stale async completions are rejected. */
export function completeProviderReservationReplay(
  state: ProviderReservationReplayGateState,
  generation: number,
): ProviderReservationReplayGateDecision {
  if (state.status !== "pending" || state.generation !== generation) {
    return { state, accepted: false, generation };
  }

  return {
    state: { ...state, status: "complete" },
    accepted: true,
    generation,
  };
}

/** A current failure returns to idle so the exact payload can be retried. */
export function failProviderReservationReplay(
  state: ProviderReservationReplayGateState,
  generation: number,
): ProviderReservationReplayGateDecision {
  if (state.status !== "pending" || state.generation !== generation) {
    return { state, accepted: false, generation };
  }

  return {
    state: { generation, payloadKey: null, status: "idle" },
    accepted: true,
    generation,
  };
}

/** Invalidate pending work on reload or a bridge-level error. */
export function resetProviderReservationReplay(
  state: ProviderReservationReplayGateState,
): ProviderReservationReplayGateState {
  return { generation: state.generation + 1, payloadKey: null, status: "idle" };
}
