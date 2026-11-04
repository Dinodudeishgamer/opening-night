// Photos from the night. Anyone who was checked in can add them from that
// moment on; every current member can look. The files are private and shown
// through signed URLs that last an hour.
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EventCtx } from '@/components/event/context';
import { ZoomableImage } from '@/components/event/zoomable-image';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { useAction } from '@/components/ui/kit';
import { Section } from '@/components/ui/section';
import { Radius, Spacing } from '@/constants/theme';
import { confirmAction, showAlert } from '@/lib/dialogs';
import { memberName } from '@/lib/format';
import { addEventPhotos, removeEventPhoto, saveEventPhoto, signedPhotoUrls } from '@/lib/images';
import { useSession } from '@/lib/session';
import type { EventPhoto } from '@/lib/types';

export function PhotosSection({ ctx }: { ctx: EventCtx }) {
  const { photos, event } = ctx.bundle;
  const { memberById } = useSession();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { busy, run } = useAction(ctx.refresh);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<EventPhoto | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [saving, setSaving] = useState(false);

  const self = ctx.mine.find((person) => person.isMe);
  const canAdd = Boolean(self?.participant.checked_in_at);
  const paths = photos.map((photo) => photo.storage_path).join('|');

  useEffect(() => {
    let current = true;
    signedPhotoUrls(paths ? paths.split('|') : []).then((signed) => {
      if (current) setUrls(signed);
    });
    return () => {
      current = false;
    };
  }, [paths]);

  // Nothing to show and nothing this viewer can do: leave the page uncluttered.
  if (photos.length === 0 && !canAdd) return null;

  const add = () =>
    run('add', async () => {
      const result = await addEventPhotos(event.id, ctx.me.member_id);
      if (result.denied) showAlert('No access to photos', 'Allow photo access for Opening Night in Settings to add photos.');
    });

  async function save(photo: EventPhoto) {
    const url = urls[photo.storage_path];
    if (!url || saving) return;
    setSaving(true);
    const result = await saveEventPhoto(url, photo.storage_path);
    setSaving(false);
    if (result === 'saved') showAlert('Saved', 'The photo is in your library.');
    else if (result === 'denied') showAlert('No access to photos', 'Allow Opening Night to add photos in Settings, then try again.');
    else if (result === 'failed') showAlert('Could not save', 'Check your connection and try again.');
  }

  // Three across, edge to edge of the page's own padding.
  const tile = Math.floor((Math.min(width, 720) - Spacing.four * 2 - Spacing.two * 2) / 3);
  const canDelete = viewing !== null && (ctx.isOwner || viewing.uploader_member_id === ctx.me.member_id);

  return (
    <Section
      title="Photos"
      count={photos.length}
      right={canAdd ? <Button title="Add" size="sm" icon="add" variant="secondary" loading={busy === 'add'} onPress={add} /> : undefined}>
      {photos.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">No photos yet. Add the selfie.</ThemedText>
      ) : (
        <View style={styles.grid}>
          {photos.map((photo) => (
            <Pressable key={photo.id} onPress={() => setViewing(photo)} accessibilityRole="imagebutton" accessibilityLabel={`Photo by ${memberName(memberById(photo.uploader_member_id))}`}>
              <Image source={urls[photo.storage_path] ? { uri: urls[photo.storage_path] } : undefined} style={{ width: tile, height: tile, borderRadius: Radius.sm }} contentFit="cover" transition={150} />
            </Pressable>
          ))}
        </View>
      )}

      <Modal visible={viewing !== null} transparent animationType="fade" onRequestClose={() => setViewing(null)} statusBarTranslucent>
        <GestureHandlerRootView style={styles.viewer}>
          {viewing && (
            <ZoomableImage
              uri={urls[viewing.storage_path]}
              width={width}
              height={height}
              onZoomChange={setZoomed}
              onTap={() => setViewing(null)}
              onDismiss={() => setViewing(null)}
            />
          )}
          {viewing && !zoomed && (
            <View style={[styles.viewerBar, { paddingBottom: Math.max(insets.bottom, Spacing.three) }]}>
              <ThemedText style={[styles.viewerText, styles.viewerName]} numberOfLines={1}>
                By {memberName(memberById(viewing.uploader_member_id))}
              </ThemedText>
              <Button title="Save" size="sm" icon="download-outline" variant="secondary" loading={saving} onPress={() => void save(viewing)} />
              {canDelete && (
                <Button
                  title="Delete"
                  size="sm"
                  variant="destructive"
                  onPress={() =>
                    confirmAction({
                      title: 'Delete this photo?',
                      message: 'It is removed for everyone.',
                      confirmLabel: 'Delete',
                      destructive: true,
                      onConfirm: () => {
                        const target = viewing;
                        setViewing(null);
                        void run('delete', () => removeEventPhoto(target.id));
                      },
                    })
                  }
                />
              )}
            </View>
          )}
        </GestureHandlerRootView>
      </Modal>
    </Section>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  viewerText: { color: '#FFFFFF' },
  viewerName: { flex: 1 },
});
