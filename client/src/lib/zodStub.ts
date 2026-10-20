// #53: what `zod` resolves to in the client build (see vite.config.ts `stubZod`). The shared
// protocol files build their schemas at import time; the client only needs their types, so every
// `z.…(…)` chain returns this same inert callable proxy. Parsing is the server's job: calling
// `parse`/`safeParse` here would be a bug, so it throws.
const fail = () => {
  throw new Error('zod is not bundled in the client');
};
const handler: ProxyHandler<() => unknown> = {
  get: (_t, key) =>
    key === 'parse' || key === 'safeParse' ? fail : key === 'then' ? undefined : chain,
  apply: () => chain,
};
const chain: unknown = new Proxy(function zodStub() {}, handler);
export const z = chain;
export default chain;
