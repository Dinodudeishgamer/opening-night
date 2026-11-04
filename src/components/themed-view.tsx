import { View, type ViewProps } from 'react-native';

import { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedViewProps = ViewProps & {
  /**
   * Which theme surface to fill with. When omitted the view is transparent —
   * most ThemedViews are layout wrappers inside a Card or Screen and must not
   * paint over the surface behind them.
   */
  type?: ThemeColor;
};

export function ThemedView({ style, type, ...otherProps }: ThemedViewProps) {
  const theme = useTheme();

  return (
    <View style={[type ? { backgroundColor: theme[type] } : undefined, style]} {...otherProps} />
  );
}
