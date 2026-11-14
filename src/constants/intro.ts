// The welcome tour's video: Dino saying hello and showing how a movie night
// works. It lives in the private "welcome" storage bucket; the tour asks for
// a short-lived link to it, so only signed-in members can watch.
//
// To replace it: upload a new vertical .mp4 (under 50 MB) to the bucket
// under a new name and change the path here. It goes out with the next
// over-the-air update; no new build is needed. Set it to null to show the
// "coming soon" card instead.
export const INTRO_VIDEO_PATH: string | null = 'opening-night-welcome-v1.mp4';
export const INTRO_VIDEO_BUCKET = 'welcome';
