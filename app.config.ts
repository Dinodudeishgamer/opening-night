// app.json holds the app's configuration. This file only adds what must not
// be committed: the Firebase settings Android needs for notifications. EAS
// builds get the file from the GOOGLE_SERVICES_JSON environment variable; a
// local build reads google-services.json from the project folder.
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
  },
});
