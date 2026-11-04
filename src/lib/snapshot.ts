// Turning something on screen into a picture and handing it to the share
// sheet. Phones only: the browser build gets snapshot.web.ts instead, so the
// native picture-taking module is never loaded there.
import * as Sharing from 'expo-sharing';
import type { RefObject } from 'react';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

export const CAN_SNAPSHOT = true;

/** Takes a picture of the view and opens the share sheet with it. Throws if either step fails. */
export async function shareSnapshot(view: RefObject<View | null>, title: string): Promise<void> {
  const uri = await captureRef(view, { format: 'png', quality: 1, result: 'tmpfile' });
  await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: title });
}
