// The browser's stand-in for snapshot.ts: there is no picture to take here,
// and whatever offers one checks CAN_SNAPSHOT first.
import type { RefObject } from 'react';
import type { View } from 'react-native';

export const CAN_SNAPSHOT = false;

export async function shareSnapshot(_view: RefObject<View | null>, _title: string): Promise<void> {
  throw new Error('Sharing a picture needs the phone app.');
}
