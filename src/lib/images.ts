// Picking, shrinking, and storing images: event photos and avatar photos.
//
// Both buckets are private. A file's path says whose it is, and the storage
// policies check that path against the signed-in member, so the app cannot
// write into anyone else's folder even if it tried. Nothing here holds a
// permanent URL: images are shown through short-lived signed URLs.
import { File as FsFile, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { actions, ApiError } from '@/lib/api';
import { supabase } from '@/lib/supabase';

const PHOTO_BUCKET = 'event-photos';
const AVATAR_BUCKET = 'avatars';
/** Longest edge of a stored event photo. */
const PHOTO_MAX_PX = 2048;
const AVATAR_PX = 256;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 -> bytes, written out rather than leaning on atob, which not every JS engine here has. */
function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const chunk =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? B64.indexOf(clean[i + 3]) : 0);
    if (at < length) bytes[at++] = (chunk >> 16) & 0xff;
    if (at < length) bytes[at++] = (chunk >> 8) & 0xff;
    if (at < length) bytes[at++] = chunk & 0xff;
  }
  return bytes;
}

function fileId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${random}`;
}

interface Rendered {
  bytes: Uint8Array;
  width: number;
  height: number;
}

// Re-encoding through the manipulator is also what drops the original's EXIF
// block (location, device), since only pixels are carried over.
async function render(
  asset: ImagePicker.ImagePickerAsset,
  size: { maxEdge: number } | { square: number },
  quality: number,
): Promise<Rendered> {
  const context = ImageManipulator.manipulate(asset.uri);
  const { width, height } = asset;
  if ('square' in size) {
    if (width && height && width !== height) {
      const side = Math.min(width, height);
      context.crop({ originX: Math.floor((width - side) / 2), originY: Math.floor((height - side) / 2), width: side, height: side });
    }
    context.resize({ width: size.square, height: size.square });
  } else if (width && height && Math.max(width, height) > size.maxEdge) {
    context.resize(width >= height ? { width: size.maxEdge } : { height: size.maxEdge });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ base64: true, compress: quality, format: SaveFormat.JPEG });
  if (!saved.base64) throw new ApiError('Could not read that image.', 'image');
  return { bytes: base64ToBytes(saved.base64), width: saved.width, height: saved.height };
}

async function pick(options: ImagePicker.ImagePickerOptions): Promise<ImagePicker.ImagePickerAsset[] | 'denied'> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return 'denied';
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    exif: false,
    // Hand over the original rather than an iCloud-transcoded copy; the
    // transcode is what fails for photos that live only in iCloud.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    ...options,
  });
  return result.canceled ? [] : result.assets;
}

/**
 * Lets the member choose photos and adds them to the event. Returns how many
 * were added. Only someone checked in to the event can do this; the bucket
 * and the database both refuse anyone else.
 */
export async function addEventPhotos(eventId: string, memberId: string): Promise<{ added: number; denied: boolean }> {
  const assets = await pick({ allowsMultipleSelection: true, selectionLimit: 10 });
  if (assets === 'denied') return { added: 0, denied: true };
  let added = 0;
  for (const asset of assets) {
    const rendered = await render(asset, { maxEdge: PHOTO_MAX_PX }, 0.82);
    const path = `${eventId}/${memberId}/${fileId()}.jpg`;
    const upload = await supabase.storage.from(PHOTO_BUCKET).upload(path, rendered.bytes, { contentType: 'image/jpeg', upsert: false });
    if (upload.error) throw new ApiError('Could not upload that photo. Only people who were checked in can add photos.', 'upload');
    try {
      await actions.registerPhoto(eventId, path, rendered.width, rendered.height, rendered.bytes.byteLength);
    } catch (error) {
      // Do not leave a file nobody can see.
      await supabase.storage.from(PHOTO_BUCKET).remove([path]);
      throw error;
    }
    added += 1;
  }
  return { added, denied: false };
}

/** Removes a photo: the list entry first (which is what authorizes it), then the file. */
/**
 * Saves one event photo to the phone's own photo library. `url` is the signed
 * URL it is already being shown from. Asks for add-only access: the app never
 * needs to read the library to do this. In a browser it opens the photo in a
 * new tab, where the browser's own Save works.
 */
export async function saveEventPhoto(url: string, storagePath: string): Promise<'saved' | 'opened' | 'denied' | 'failed'> {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener');
    return 'opened';
  }
  try {
    // Loaded on demand, like the calendar: nothing else in the app needs it.
    const MediaLibrary = await import('expo-media-library');
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return 'denied';

    const extension = /\.(jpe?g|png|heic|webp)$/i.exec(storagePath)?.[1].toLowerCase() ?? 'jpg';
    const target = new FsFile(Paths.cache, `opening-night-photo-${Date.now()}.${extension}`);
    if (target.exists) target.delete();
    const file = await FsFile.downloadFileAsync(url, target);
    try {
      await MediaLibrary.saveToLibraryAsync(file.uri);
    } finally {
      if (file.exists) file.delete();
    }
    return 'saved';
  } catch {
    return 'failed';
  }
}

export async function removeEventPhoto(mediaId: string): Promise<void> {
  const path = await actions.deletePhoto(mediaId);
  await supabase.storage.from(PHOTO_BUCKET).remove([path]);
}

/** Removes the files of an event that is being deleted. Best effort. */
export async function removeEventFiles(paths: string[]): Promise<void> {
  if (paths.length > 0) await supabase.storage.from(PHOTO_BUCKET).remove(paths);
}

export async function signedPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  const urls: Record<string, string> = {};
  for (const entry of data ?? []) if (entry.path && entry.signedUrl) urls[entry.path] = entry.signedUrl;
  return urls;
}

/** Deletes every picture file in the member's own avatar folder. Best effort. */
export async function removeMyAvatarFiles(memberId: string): Promise<void> {
  try {
    const { data } = await supabase.storage.from(AVATAR_BUCKET).list(memberId);
    const paths = (data ?? []).map((file) => `${memberId}/${file.name}`);
    if (paths.length > 0) await supabase.storage.from(AVATAR_BUCKET).remove(paths);
  } catch {
    // The account is deleted either way; a stray file is unreachable once its owner is gone.
  }
}

/** Lets the member choose and crop a photo, stores it, and makes it their avatar. */
export async function choosePhotoAvatar(memberId: string): Promise<'done' | 'canceled' | 'denied'> {
  const assets = await pick({ allowsEditing: true, aspect: [1, 1] });
  if (assets === 'denied') return 'denied';
  if (assets.length === 0) return 'canceled';
  const rendered = await render(assets[0], { square: AVATAR_PX }, 0.75);
  // A new name each time, so a cached signed URL never shows the old face.
  const path = `${memberId}/${fileId()}.jpg`;
  const upload = await supabase.storage.from(AVATAR_BUCKET).upload(path, rendered.bytes, { contentType: 'image/jpeg', upsert: false });
  if (upload.error) throw new ApiError('Could not upload that photo.', 'upload');
  await actions.setMyAvatar('photo', null, path);
  return 'done';
}

const avatarUrls = new Map<string, { url: string; expires: number }>();

/** A signed URL for an avatar path, cached for most of its lifetime. */
export async function avatarUrl(path: string): Promise<string | null> {
  const cached = avatarUrls.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!data?.signedUrl) return null;
  avatarUrls.set(path, { url: data.signedUrl, expires: Date.now() + (SIGNED_URL_TTL_SECONDS - 300) * 1000 });
  return data.signedUrl;
}
