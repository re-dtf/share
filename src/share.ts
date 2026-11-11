/**
 * reDTF Share — динамические Open Graph превью для мессенджеров и соцсетей.
 *
 * - Боты: берут метаданные поста с api.dtf.ru и получают лёгкий HTML с тегами og:*.
 * - Люди: мгновенный 302 на целевой клиент (по умолчанию https://redtf.org).
 * - Настраивается переменными окружения (см. README).
 * - Ходит в API DTF только по промаху кэша и не чаще лимита (см. `Runtime.limiter`).
 */

export interface ShareConfig {
	targetOrigin: string;
	dtfApiUrl: string;
	defaultTitle: string;
	defaultDescription: string;
	defaultImage: string;
	siteName: string;
	cacheTtl: number;
}

/** Только те поля ответа `GET /content`, которые мы читаем. */
interface DtfMedia {
	data?: { uuid?: string };
}

interface DtfBlock {
	type?: string;
	/** Блок попадает в превью поста в ленте */
	cover?: boolean;
	/** Для text — спойлер */
	hidden?: boolean;
	data?: { text?: string; items?: { image?: DtfMedia }[] };
}

export interface DtfPost {
	title?: string;
	ogTitle?: string | null;
	ogDescription?: string | null;
	blocks?: DtfBlock[];
	media?: DtfMedia | null;
	customCover?: DtfMedia | null;
	isPublished?: boolean;
	/** Помечен как 18+: картинку нельзя показывать без блюра */
	isBlur?: boolean;
	/** Непустой — пост скрыт по требованию (правообладатель, Роскомнадзор…) */
	withheld?: unknown[];
	subsite?: { name?: string };
	author?: { name?: string };
}

export interface Meta {
	title: string;
	description: string;
	image: string;
}

/** Окружение, которого нет у обычного обработчика (задаёт только Cloudflare-вход). */
export interface Runtime {
	cache?: {
		match(request: Request): Promise<Response | undefined>;
		put(request: Request, response: Response): Promise<void>;
	};
	waitUntil?(promise: Promise<unknown>): void;
	/** Общий лимит на походы в API DTF (Cloudflare Rate Limiting binding); без него лимита нет */
	limiter?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const BOT_UA_REGEX =
	/bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|discord|vkshare|viber|mastodon|preview|embed|curl|wget|cardyb|iframely/i;

/** Служебные параметры сервиса: на целевой сайт не передаются. */
const SERVICE_PARAMS = ["preview", "og", "redirect"];
/** Длина id ограничена, чтобы не плодить заведомо пустые ключи кэша и запросы к DTF */
const POST_PATH = /^\/post\/(\d{1,10})\/?$/;
const DESCRIPTION_LIMIT = 250;
/** Сколько ботам и кэшам держать превью, когда пост получить не удалось */
const ERROR_TTL = 60;
/** Через сколько боту стоит прийти снова, если сработал лимит запросов к DTF */
const RETRY_AFTER = 30;

export function getConfig(env?: Record<string, string | undefined>): ShareConfig {
	const get = (key: string): string | undefined => env?.[key];

	const ttl = parseInt(get("CACHE_TTL") ?? "", 10);

	return {
		targetOrigin: (get("TARGET_ORIGIN") || "https://redtf.org").replace(/\/+$/, ""),
		dtfApiUrl: (get("DTF_API_URL") || "https://api.dtf.ru/v2.31").replace(/\/+$/, ""),
		defaultTitle: get("DEFAULT_TITLE") || "reDTF — неофициальный клиент DTF",
		defaultDescription:
			get("DEFAULT_DESCRIPTION") ||
			"Неофициальный легковесный клиент для DTF с открытым исходным кодом, глубокой кастомизацией и темами разных эпох дизайна.",
		defaultImage: get("DEFAULT_IMAGE") || "https://redtf.org/icons/app-default-512.png",
		siteName: get("SITE_NAME") || "reDTF",
		cacheTtl: ttl >= 0 ? ttl : 7200,
	};
}

export function isCrawler(userAgent: string, url: URL): boolean {
	if (url.searchParams.has("preview") || url.searchParams.has("og")) return true;
	if (url.searchParams.has("redirect")) return false;
	return BOT_UA_REGEX.test(userAgent);
}

export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	laquo: "«",
	raquo: "»",
	mdash: "—",
	ndash: "–",
	hellip: "…",
};

export function stripHtml(html: string): string {
	return html
		.replace(/<\/?(b|i|strong|em|a|span|mark|small|u|s)[^>]*>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
			if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
			const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
		})
		.replace(/\s+/g, " ")
		.trim();
}

export function defaultMeta(config: ShareConfig): Meta {
	return { title: config.defaultTitle, description: config.defaultDescription, image: config.defaultImage };
}

/** Блоки с флагом `cover` (то, что DTF показывает в превью) идут первыми. */
const coverFirst = <T extends { cover?: boolean }>(items: T[]): T[] => [
	...items.filter((item) => item.cover),
	...items.filter((item) => !item.cover),
];

export function extractPostMetadata(post: DtfPost, config: ShareConfig): Meta {
	// Неопубликованное и скрытое не раскрываем
	if (post.isPublished === false || post.withheld?.length) return defaultMeta(config);

	const blocks = Array.isArray(post.blocks) ? post.blocks : [];
	const place = post.subsite?.name || post.author?.name;

	const title = (post.ogTitle || post.title || "").trim() || (place ? `Заметка (${place})` : config.defaultTitle);

	// Описание: текст из cover-блока → любой открытый текст → ogDescription (у DTF это SEO-набор слов)
	const texts = coverFirst(blocks.filter((b) => b.type === "text" && !b.hidden));
	const raw =
		[...texts.map((b) => b.data?.text ?? ""), post.ogDescription ?? ""].map(stripHtml).find(Boolean) ||
		config.defaultDescription;
	const chars = Array.from(raw); // по символам, чтобы не разрезать эмодзи
	const description = chars.length > DESCRIPTION_LIMIT ? chars.slice(0, DESCRIPTION_LIMIT - 3).join("").trim() + "…" : raw;

	let uuid = post.media?.data?.uuid || post.customCover?.data?.uuid;
	if (!uuid) {
		uuid = coverFirst(blocks.filter((b) => b.type === "media"))
			.flatMap((b) => b.data?.items ?? [])
			.map((item) => item.image?.data?.uuid)
			.find(Boolean);
	}
	const image = uuid && !post.isBlur ? `https://leonardo.osnova.io/${uuid}/-/preview/1200/-/format/jpg/` : config.defaultImage;

	return { title, description, image };
}

/**
 * `canonicalUrl` — страница на целевом сайте (куда ведёт ссылка).
 * Автоперехода (`meta refresh`) нет намеренно: боты, например Telegram, идут по нему на целевой сайт,
 * а он на GitHub Pages отвечает 404 для адресов SPA, и карточка не строится. Людей перенаправляет 302.
 * `ogUrl` — адрес самого шлюза: краулеры, которые идут по `og:url`, должны остаться на нём,
 * а не уйти на SPA без тегов. По умолчанию совпадает с `canonicalUrl`.
 */
export function renderHtmlPage(params: Meta & { canonicalUrl: string; siteName: string; ogUrl?: string }): string {
	const { title, description, image, canonicalUrl, siteName, ogUrl = canonicalUrl } = params;
	const eTitle = escapeHtml(title);
	const eDesc = escapeHtml(description);
	const eImage = escapeHtml(image);
	const eUrl = escapeHtml(canonicalUrl);
	const eOgUrl = escapeHtml(ogUrl);
	const eSiteName = escapeHtml(siteName);

	return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${eTitle} — ${eSiteName}</title>
  <meta name="description" content="${eDesc}">
  <link rel="canonical" href="${eUrl}">
  <meta property="og:site_name" content="${eSiteName}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${eTitle}">
  <meta property="og:description" content="${eDesc}">
  <meta property="og:image" content="${eImage}">
  <meta property="og:url" content="${eOgUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${eTitle}">
  <meta name="twitter:description" content="${eDesc}">
  <meta name="twitter:image" content="${eImage}">
</head>
<body>
  <p><a href="${eUrl}">Открыть в ${eSiteName}</a></p>
</body>
</html>`;
}

/** Адрес на целевом сайте: путь и параметры запроса без служебных. */
function buildTargetUrl(config: ShareConfig, url: URL): string {
	const params = new URLSearchParams(url.search);
	for (const key of SERVICE_PARAMS) params.delete(key);
	const query = params.toString();
	return `${config.targetOrigin}${url.pathname}${query ? `?${query}` : ""}`;
}

// Ответ зависит от User-Agent, поэтому любой кэш перед сервисом обязан это учитывать
function redirect(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: location, "Cache-Control": "no-store", Vary: "User-Agent" },
	});
}

function htmlResponse(html: string, ttl: number): Response {
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": `public, max-age=${ttl}`,
			"Content-Security-Policy": "default-src 'none'",
			"X-Content-Type-Options": "nosniff",
			Vary: "User-Agent",
		},
	});
}

/**
 * Пост из API DTF или `undefined`, если его не удалось получить (404, 403, сеть, тайм-аут).
 * Причину пишем в лог: иначе блокировка воркера на стороне DTF осталась бы незаметной
 * (боты при этом получают обычное превью сайта).
 */
async function fetchPost(config: ShareConfig, id: string): Promise<DtfPost | undefined> {
	try {
		const res = await fetch(`${config.dtfApiUrl}/content?id=${id}`, {
			headers: { "User-Agent": "reDTF-Share/1.0" },
			signal: AbortSignal.timeout(4000),
		});
		if (!res.ok) {
			// 404 — обычное дело (удалённый пост), остальное похоже на блокировку или сбой DTF
			if (res.status !== 404) console.warn(`DTF вернул ${res.status} для поста ${id}`);
			return undefined;
		}
		return ((await res.json()) as { result?: DtfPost })?.result;
	} catch (error) {
		console.warn(`Не удалось получить пост ${id}: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}
}

export async function handleRequest(
	request: Request,
	env?: Record<string, string | undefined>,
	runtime: Runtime = {}
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
	}

	const config = getConfig(env);
	const url = new URL(request.url);

	// Человека сразу отправляем на целевой сайт
	if (!isCrawler(request.headers.get("user-agent") || "", url)) {
		return redirect(buildTargetUrl(config, url));
	}

	// Бот: превью есть только у главной и у /post/<id>
	const postMatch = url.pathname.match(POST_PATH);
	if (url.pathname !== "/" && !postMatch) {
		return new Response("Not Found", { status: 404, headers: { Vary: "User-Agent" } });
	}

	const siteName = config.siteName;
	if (!postMatch) {
		const html = renderHtmlPage({
			...defaultMeta(config),
			canonicalUrl: config.targetOrigin,
			ogUrl: `${url.origin}/`,
			siteName,
		});
		return htmlResponse(html, config.cacheTtl);
	}

	// Адрес шлюза без параметров запроса: он же ключ кэша, поэтому параметры кэш не обходят,
	// а смена TARGET_ORIGIN и кэш CDN целевого сайта с ним не пересекаются
	const ogUrl = `${url.origin}/post/${postMatch[1]}`;
	const cacheKey = new Request(ogUrl);
	const cached = await runtime.cache?.match(cacheKey);
	if (cached) return cached;

	// Поход в DTF — единственное, чем нас можно заспамить: ключи кэша бесконечны (любой id).
	// Общий лимит бережёт воркер от бана на стороне DTF; бот на время получает 429 без карточки
	if (runtime.limiter && !(await runtime.limiter.limit({ key: "dtf" })).success) {
		return new Response("Too Many Requests", {
			status: 429,
			headers: { "Retry-After": String(RETRY_AFTER), "Cache-Control": "no-store", Vary: "User-Agent" },
		});
	}

	// Не удалось получить пост — отдаём боту обычное превью сайта (а не 302 на пустой SPA,
	// иначе мессенджер надолго запомнит пустую карточку) и просим скоро зайти снова.
	// Сбой кэшируем так же, как успех, но на короткий срок: повторы по одному id в DTF не ходят
	const post = await fetchPost(config, postMatch[1]);
	const meta = post ? extractPostMetadata(post, config) : defaultMeta(config);
	const canonicalUrl = `${config.targetOrigin}/post/${postMatch[1]}`;
	const response = htmlResponse(
		renderHtmlPage({ ...meta, canonicalUrl, ogUrl, siteName }),
		post ? config.cacheTtl : ERROR_TTL
	);

	if (runtime.cache) runtime.waitUntil?.(runtime.cache.put(cacheKey, response.clone()));
	return response;
}
