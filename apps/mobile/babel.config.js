/**
 * Babel config for the Expo app.
 *
 * `babel-preset-expo` already handles the React Native transform, TypeScript
 * stripping and the `process.env.EXPO_PUBLIC_*` inlining that the Supabase
 * config relies on. Nothing else is needed.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
