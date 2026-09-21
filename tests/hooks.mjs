export async function resolve(specifier, context, next) {
  if (specifier.endsWith("/push.js") || specifier === "./push.js") return { url: new URL("./push-mock.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
