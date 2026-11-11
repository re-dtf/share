import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getConfig,
	isCrawler,
	escapeHtml,
	stripHtml,
	extractPostMetadata,
	renderHtmlPage,
	handleRequest,
	type DtfPost,
} from "./share.ts";

const BOT = "TelegramBot (like TwitterBot)";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
const UUID = "621113bc-87fc-50ab-8304-86751e42416c";
const imageUrl = (uuid: string) => `https://leonardo.osnova.io/${uuid}/-/preview/1200/-/format/jpg/`;

const config = getConfig({});

/** Пост в форме реального ответа `GET /content` (урезан до нужных полей). */
const post = (override: DtfPost = {}): DtfPost => ({
	title: "Состоялся релиз ремейка The Legend of Zelda: Ocarina of Time",
	ogTitle: null,
	ogDescription: "Ремейк, Switch 2, обновленная графика, новые механики",
	isPublished: true,
	isBlur: false,
	withheld: [],
	media: { data: { uuid: UUID } },
	customCover: null,
	subsite: { name: "Игры" },
	author: { name: "Автор" },
	blocks: [
		{ type: "text", cover: true, hidden: false, data: { text: "<p>Пока адвенчура от Nintendo — самая высокооценённая игра года.</p>" } },
		{ type: "media", cover: true, hidden: false, data: { items: [{ image: { data: { uuid: UUID } } }] } },
		{ type: "text", cover: false, hidden: false, data: { text: "<p>Остальной текст.</p>" } },
	],
	...override,
});

describe("getConfig", () => {
	it("возвращает настройки по умолчанию", () => {
		const c = getConfig({});
		assert.equal(c.targetOrigin, "https://redtf.org");
		assert.equal(c.siteName, "reDTF");
		assert.equal(c.cacheTtl, 7200);
		assert.equal(c.dtfApiUrl, "https://api.dtf.ru/v2.31");
		assert.ok(c.defaultImage.includes("app-default-512.png"));
	});

	it("учитывает переменные окружения и убирает завершающий слэш", () => {
		const c = getConfig({ TARGET_ORIGIN: "https://my-client.com///", SITE_NAME: "MyDTF", CACHE_TTL: "3600" });
		assert.equal(c.targetOrigin, "https://my-client.com");
		assert.equal(c.siteName, "MyDTF");
		assert.equal(c.cacheTtl, 3600);
	});

	it("при некорректном CACHE_TTL берёт значение по умолчанию", () => {
		assert.equal(getConfig({ CACHE_TTL: "abc" }).cacheTtl, 7200);
		assert.equal(getConfig({ CACHE_TTL: "-5" }).cacheTtl, 7200);
	});
});

describe("isCrawler", () => {
	const url = new URL("https://s.redtf.org/post/1");

	it("распознаёт ботов мессенджеров и соцсетей", () => {
		for (const ua of [
			BOT,
			"Mozilla/5.0 (compatible; Twitterbot/1.0)",
			"Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
			"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
			"vkShare; +http://vk.com/share.php",
			"WhatsApp/2.21.12.21 A",
			"Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
			"Viber/19.0",
			"http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)",
			"Bluesky Cardyb/1.1",
			"Iframely/1.3.1 (+https://iframely.com/docs/about)",
		]) {
			assert.equal(isCrawler(ua, url), true, ua);
		}
	});

	it("не считает ботами обычные браузеры", () => {
		for (const ua of [
			BROWSER,
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
		]) {
			assert.equal(isCrawler(ua, url), false, ua);
		}
	});

	it("?preview и ?og включают режим бота, ?redirect выключает", () => {
		assert.equal(isCrawler(BROWSER, new URL("https://s.redtf.org/post/1?preview=1")), true);
		assert.equal(isCrawler(BROWSER, new URL("https://s.redtf.org/post/1?og=true")), true);
		assert.equal(isCrawler(BOT, new URL("https://s.redtf.org/post/1?redirect=1")), false);
	});
});

describe("escapeHtml и stripHtml", () => {
	it("экранирует спецсимволы", () => {
		assert.equal(
			escapeHtml(`<script>alert("a & 'b'")</script>`),
			"&lt;script&gt;alert(&quot;a &amp; &#39;b&#39;&quot;)&lt;/script&gt;"
		);
	});

	it("убирает теги и декодирует сущности", () => {
		assert.equal(stripHtml("<p>Привет, <b>DTF</b>! &quot;Кавычки&quot; &amp; &nbsp;пробелы.</p>"), 'Привет, DTF! "Кавычки" & пробелы.');
		assert.equal(stripHtml("&laquo;Раз&raquo; &#171;два&#xBB; &mdash; три"), "«Раз» «два» — три");
	});

	it("декодированные теги остаются текстом, а не разметкой", () => {
		assert.equal(stripHtml("&lt;b&gt;x&lt;/b&gt;"), "<b>x</b>");
	});
});

describe("extractPostMetadata", () => {
	it("берёт заголовок, текст cover-блока и картинку поста", () => {
		const meta = extractPostMetadata(post(), config);
		assert.equal(meta.title, "Состоялся релиз ремейка The Legend of Zelda: Ocarina of Time");
		assert.equal(meta.description, "Пока адвенчура от Nintendo — самая высокооценённая игра года.");
		assert.equal(meta.image, imageUrl(UUID));
	});

	it("ogTitle важнее title", () => {
		assert.equal(extractPostMetadata(post({ ogTitle: "Заголовок для соцсетей" }), config).title, "Заголовок для соцсетей");
	});

	it("cover-блок идёт раньше обычных, спойлер пропускается", () => {
		const blocks = [
			{ type: "text", cover: false, hidden: true, data: { text: "Спойлер" } },
			{ type: "text", cover: false, hidden: false, data: { text: "Обычный текст" } },
			{ type: "text", cover: true, hidden: false, data: { text: "Лид" } },
		];
		assert.equal(extractPostMetadata(post({ blocks }), config).description, "Лид");
		assert.equal(extractPostMetadata(post({ blocks: blocks.slice(0, 2) }), config).description, "Обычный текст");
	});

	it("без открытого текста берёт ogDescription, потом описание сайта", () => {
		const blocks = [{ type: "text", cover: false, hidden: true, data: { text: "Спойлер" } }];
		assert.equal(extractPostMetadata(post({ blocks }), config).description, "Ремейк, Switch 2, обновленная графика, новые механики");
		assert.equal(extractPostMetadata(post({ blocks, ogDescription: null }), config).description, config.defaultDescription);
	});

	it("без заголовка называет заметку по подсайту, без подсайта — по автору", () => {
		assert.equal(extractPostMetadata(post({ title: "" }), config).title, "Заметка (Игры)");
		assert.equal(extractPostMetadata(post({ title: "", subsite: undefined }), config).title, "Заметка (Автор)");
		assert.equal(extractPostMetadata(post({ title: "", subsite: undefined, author: undefined }), config).title, config.defaultTitle);
	});

	it("без media берёт картинку из media-блока, cover-блок первым", () => {
		const blocks = [
			{ type: "media", cover: false, data: { items: [{ image: { data: { uuid: "other" } } }] } },
			{ type: "media", cover: true, data: { items: [{ image: { data: { uuid: "cover" } } }] } },
		];
		assert.equal(extractPostMetadata(post({ media: null, blocks }), config).image, imageUrl("cover"));
		assert.equal(extractPostMetadata(post({ media: null, blocks: [] }), config).image, config.defaultImage);
	});

	it("картинку поста 18+ (isBlur) не показывает", () => {
		assert.equal(extractPostMetadata(post({ isBlur: true }), config).image, config.defaultImage);
	});

	it("неопубликованный и скрытый пост отдаёт обычным превью сайта", () => {
		for (const hidden of [{ isPublished: false }, { withheld: [{ reason: "x" }] }]) {
			assert.deepEqual(extractPostMetadata(post(hidden), config), {
				title: config.defaultTitle,
				description: config.defaultDescription,
				image: config.defaultImage,
			});
		}
	});

	it("обрезает длинное описание по символам, не разрезая эмодзи", () => {
		const blocks = [{ type: "text", data: { text: "😀".repeat(300) } }];
		const { description } = extractPostMetadata(post({ blocks }), config);
		assert.equal(Array.from(description).length, 248);
		assert.ok(description.endsWith("…"));
		assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(description));
	});
});

describe("renderHtmlPage", () => {
	it("экранирует данные поста и не содержит скриптов", () => {
		const html = renderHtmlPage({
			title: `"><script>alert(1)</script>`,
			description: "</title><img src=x onerror=alert(1)>",
			image: config.defaultImage,
			canonicalUrl: "https://redtf.org/post/1",
			siteName: "reDTF",
		});
		assert.ok(!html.includes("<script"));
		assert.ok(!html.includes("<img"));
		assert.ok(html.includes("&lt;script&gt;"));
	});
});

describe("handleRequest", () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];

	/** Подменяет fetch: отдаёт `body` со статусом `status` или бросает ошибку (body === "throw"). */
	const mockApi = (body: unknown, status = 200) => {
		calls.length = 0;
		globalThis.fetch = async (input: RequestInfo | URL) => {
			calls.push(String(input));
			if (body === "throw") throw new Error("network");
			return new Response(JSON.stringify(body), { status });
		};
	};

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const get = (path: string, ua = BOT, env?: Record<string, string>, runtime?: Parameters<typeof handleRequest>[2]) =>
		handleRequest(new Request(`https://s.redtf.org${path}`, { headers: { "user-agent": ua } }), env, runtime);

	it("человека редиректит на целевой сайт, убирая служебные параметры", async () => {
		mockApi({});
		const res = await get("/post/5394366?comment=123&redirect=1", BROWSER);
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("Location"), "https://redtf.org/post/5394366?comment=123");
		assert.equal(res.headers.get("Cache-Control"), "no-store");
		assert.equal(res.headers.get("Vary"), "User-Agent");
		assert.equal(calls.length, 0);
	});

	it("человека на главной редиректит на корень клиента", async () => {
		assert.equal((await get("/", BROWSER)).headers.get("Location"), "https://redtf.org/");
	});

	it("учитывает TARGET_ORIGIN из env", async () => {
		const res = await get("/post/100", BROWSER, { TARGET_ORIGIN: "https://my-dtf.org" });
		assert.equal(res.headers.get("Location"), "https://my-dtf.org/post/100");
	});

	it("отвечает 405 на методы кроме GET и HEAD", async () => {
		const res = await handleRequest(new Request("https://s.redtf.org/post/1", { method: "POST" }));
		assert.equal(res.status, 405);
		assert.equal(res.headers.get("Allow"), "GET, HEAD");
	});

	it("боту на главной отдаёт HTML с тегами сайта", async () => {
		const res = await get("/");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
		assert.equal(res.headers.get("Vary"), "User-Agent");
		const html = await res.text();
		assert.ok(html.includes('<meta property="og:site_name" content="reDTF">'));
		assert.ok(html.includes('<meta property="og:title" content="reDTF — неофициальный клиент DTF">'));
	});

	it("боту на /post/:id отдаёт метаданные поста из API", async () => {
		mockApi({ result: post({ title: "Тест & <заголовок>" }) });
		const res = await get("/post/5394366?utm=1");
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Cache-Control"), "public, max-age=7200");
		assert.equal(res.headers.get("Content-Security-Policy"), "default-src 'none'");
		assert.deepEqual(calls, ["https://api.dtf.ru/v2.31/content?id=5394366"]);

		const html = await res.text();
		assert.ok(html.includes("<title>Тест &amp; &lt;заголовок&gt; — reDTF</title>"));
		assert.ok(html.includes(`<meta property="og:image" content="${imageUrl(UUID)}">`));
		// og:url остаётся на шлюзе, а canonical и ссылка ведут на клиент
		assert.ok(html.includes('<meta property="og:url" content="https://s.redtf.org/post/5394366">'));
		assert.ok(html.includes('<link rel="canonical" href="https://redtf.org/post/5394366">'));
		assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
		assert.ok(html.includes('<a href="https://redtf.org/post/5394366">'));
		// автоперехода нет: Telegram идёт по нему на целевой сайт (404 у GitHub Pages) и не строит карточку
		assert.ok(!html.includes("http-equiv"));
	});

	it("?preview=1 отдаёт HTML и обычному браузеру", async () => {
		mockApi({ result: post() });
		const res = await get("/post/1?preview=1", BROWSER);
		assert.equal(res.status, 200);
		assert.ok((await res.text()).includes('<meta property="og:title"'));
	});

	for (const [name, setup] of [
		["404 от API", () => mockApi({}, 404)],
		["сетевая ошибка", () => mockApi("throw")],
		["ответ без result", () => mockApi({})],
	] as const) {
		it(`при сбое (${name}) боту отдаёт превью сайта и короткий кэш`, async () => {
			setup();
			const res = await get("/post/9999999");
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
			const html = await res.text();
			assert.ok(html.includes('<meta property="og:title" content="reDTF — неофициальный клиент DTF">'));
			assert.ok(html.includes('<meta property="og:url" content="https://s.redtf.org/post/9999999">'));
		});
	}

	it("логирует ошибки DTF, кроме обычного 404", async () => {
		const warn = console.warn;
		const logs: string[] = [];
		console.warn = (message: string) => void logs.push(message);
		try {
			mockApi({}, 404);
			await get("/post/1");
			assert.equal(logs.length, 0);
			mockApi({}, 403);
			await get("/post/1");
			mockApi("throw");
			await get("/post/1");
			assert.equal(logs.length, 2);
		} finally {
			console.warn = warn;
		}
	});

	it("неопубликованный пост не раскрывает", async () => {
		mockApi({ result: post({ isPublished: false }) });
		const html = await (await get("/post/1")).text();
		assert.ok(!html.includes("Zelda"));
		assert.ok(html.includes("неофициальный клиент DTF"));
	});

	it("боту на остальных путях отвечает 404 и не ходит в API", async () => {
		mockApi({ result: post() });
		for (const path of ["/robots.txt", "/favicon.ico", "/post/123abc", "/post/", "/u/1", "/post/12345678901"]) {
			assert.equal((await get(path)).status, 404, path);
		}
		assert.equal(calls.length, 0);
	});

	describe("кэш воркера", () => {
		const store = new Map<string, Response>();
		const pending: Promise<unknown>[] = [];
		const runtime = {
			cache: {
				match: async (request: Request) => store.get(request.url)?.clone(),
				put: async (request: Request, response: Response) => void store.set(request.url, response),
			},
			waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
		};

		afterEach(() => {
			store.clear();
			pending.length = 0;
		});

		it("повторный запрос поста обслуживается из кэша, параметры его не обходят", async () => {
			mockApi({ result: post() });
			await get("/post/1", BOT, undefined, runtime);
			await Promise.all(pending);
			assert.equal(calls.length, 1);

			const res = await get("/post/1?x=" + Math.random(), BOT, undefined, runtime);
			assert.equal(calls.length, 1);
			assert.ok((await res.text()).includes("Zelda"));
		});

		it("сбой API тоже кэшируется (на короткий срок), повторы в DTF не ходят", async () => {
			mockApi({}, 404);
			await get("/post/1", BOT, undefined, runtime);
			await Promise.all(pending);
			assert.equal(store.size, 1);

			const res = await get("/post/1", BOT, undefined, runtime);
			assert.equal(calls.length, 1);
			assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
		});

		it("ключ кэша не зависит от TARGET_ORIGIN и параметров запроса", async () => {
			mockApi({ result: post() });
			await get("/post/1?x=1", BOT, { TARGET_ORIGIN: "https://my-dtf.org" }, runtime);
			await Promise.all(pending);
			assert.equal(store.size, 1);
			assert.match([...store.keys()][0], /^https:\/\/s\.redtf\.org\/post\/1\?v=\d+$/);
		});

		describe("лимит запросов к DTF", () => {
			const limiterOf = (success: boolean) => ({
				limit: async () => ({ success }),
			});

			it("сверх лимита бот получает 429 без похода в DTF и без кэша", async () => {
				mockApi({ result: post() });
				const res = await get("/post/1", BOT, undefined, { ...runtime, limiter: limiterOf(false) });
				assert.equal(res.status, 429);
				assert.equal(res.headers.get("Retry-After"), "30");
				assert.equal(res.headers.get("Cache-Control"), "no-store");
				await Promise.all(pending);
				assert.equal(calls.length, 0);
				assert.equal(store.size, 0);
			});

			it("кэш отдаётся и при исчерпанном лимите, в лимитер ходят только по промаху", async () => {
				mockApi({ result: post() });
				let checked = 0;
				const limiter = { limit: async () => (checked++, { success: true }) };
				await get("/post/1", BOT, undefined, { ...runtime, limiter });
				await Promise.all(pending);
				const res = await get("/post/1", BOT, undefined, { ...runtime, limiter: limiterOf(false) });
				assert.equal(res.status, 200);
				assert.equal(checked, 1);
			});

			it("человека и главную лимит не затрагивает", async () => {
				mockApi({});
				const runtimeBlocked = { ...runtime, limiter: limiterOf(false) };
				assert.equal((await get("/post/1", BROWSER, undefined, runtimeBlocked)).status, 302);
				assert.equal((await get("/", BOT, undefined, runtimeBlocked)).status, 200);
			});
		});

		it("человек кэш не видит", async () => {
			mockApi({ result: post() });
			await get("/post/1", BOT, undefined, runtime);
			await Promise.all(pending);
			const res = await get("/post/1", BROWSER, undefined, runtime);
			assert.equal(res.status, 302);
		});
	});
});
