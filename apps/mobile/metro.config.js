/**
 * Metro config for a pnpm workspace monorepo.
 *
 * Three things are needed for `@wallet/shared` to resolve, hot-reload and
 * behave:
 *   1. `watchFolders` must include the workspace root, otherwise edits inside
 *      `packages/shared` never trigger a rebuild.
 *   2. `nodeModulesPaths` must list both `node_modules` directories so Metro
 *      can find hoisted dependencies.
 *   3. `react` must resolve to exactly one copy — see below. This is not
 *      optional and it is not caught by the bundler.
 *
 * The root `.npmrc` sets `node-linker=hoisted`, which keeps the dependency
 * tree flat enough for Metro — pnpm's default symlinked layout is the single
 * most common cause of "Unable to resolve module" in an Expo monorepo.
 */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Resolve `@wallet/shared` straight to its TypeScript source.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@wallet/shared': path.resolve(workspaceRoot, 'packages/shared'),
};

/**
 * Pin React to a single copy.
 *
 * Metro resolves a bare import by walking up from the *importing file*. Every
 * file in `packages/shared` therefore finds `packages/shared/node_modules/react`
 * — a second install that exists because that package keeps its own `react`
 * devDependency so its hooks typecheck standalone. The app gets the hoisted
 * `node_modules/react`, which is the 18.2.0 that React Native 0.74 pins.
 *
 * Two copies means two dispatchers: the shared hooks register with one and the
 * renderer sets the other, so the first hook call throws
 * `Cannot read property 'useState' of null`. The bundle builds perfectly — the
 * failure is runtime-only, which is why `.review/react-copies.mjs` asserts it.
 *
 * Note that matching the *versions* would not help: two copies at the same
 * version still fail. The module instance is what matters, so the fix is to
 * resolve these names as though they were imported from the app root.
 */
const SINGLETONS = ['react', 'react-dom', 'react-native'];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSingleton =
    SINGLETONS.includes(moduleName) ||
    SINGLETONS.some((name) => moduleName.startsWith(`${name}/`));

  if (!isSingleton) {
    return context.resolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(
    { ...context, originModulePath: path.join(projectRoot, 'index.ts') },
    moduleName,
    platform,
  );
};

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
