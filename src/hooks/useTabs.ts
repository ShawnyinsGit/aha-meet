import { useSyncExternalStore } from 'react';
import { meetingStore, type TabMeta } from '../lib/meeting-store';

/** Subscribes to the tab projection of the multi-slot meeting store. Re-renders
 *  whenever tabs are added/removed, status flips, unread badges change, or the
 *  active tab switches. Cheap — projection is recomputed on demand from the
 *  slot map. */
export function useTabs(): TabMeta[] {
  return useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getTabs);
}
