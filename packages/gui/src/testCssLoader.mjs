/**
 * A one-off Node ESM loader hook used only by App.smoke.test.tsx: tsx's
 * loader handles TS/TSX transforms but has no opinion on `.css` imports
 * (that's a Vite-bundler-only convention) — this treats any `.css`
 * specifier as an empty module so importing a real component file that
 * imports its stylesheet doesn't crash a plain Node ESM load.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    return { url: `css-noop:${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("css-noop:")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  return nextLoad(url, context);
}
