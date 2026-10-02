/**
 * Expo entry point.
 *
 * Order matters:
 *   1. `react-native-url-polyfill` — supabase-js constructs `URL` objects at
 *      import time, and Hermes only ships a partial `URL` implementation.
 *   2. the Supabase config module — must run before any service is called.
 *   3. the app itself.
 *
 * ES module imports are evaluated in source order, so this is guaranteed.
 */

import 'react-native-url-polyfill/auto';
import './src/config/supabase';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
