import { handleRequest, type Runtime } from "./share.ts";

interface Env extends Record<string, unknown> {
	/** Rate Limiting binding из wrangler.toml; без него (свой деплой) лимита нет */
	DTF_LIMITER?: Runtime["limiter"];
}

export default {
	fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
		// Cache API работает только на своём домене (на *.workers.dev кэша нет)
		return handleRequest(request, env as Record<string, string | undefined>, {
			cache: caches.default,
			waitUntil: (promise) => ctx.waitUntil(promise),
			limiter: env.DTF_LIMITER,
		});
	},
};
