import { useSyncExternalStore } from 'react';
import { getSaveError, getState, isLoaded, subscribe } from './store';
import type { Database } from './types';

/** The whole database. Fine at this scale — the store swaps one object. */
export function useDatabase(): Database {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function useLoaded(): boolean {
  return useSyncExternalStore(subscribe, isLoaded, isLoaded);
}

export function useSaveError(): string | null {
  return useSyncExternalStore(subscribe, getSaveError, getSaveError);
}
