/**
 * sw.js — Service Worker de ATSHEL
 * Versión base reemplazada automáticamente en build por `atshelSwManifestPlugin`
 */

'use strict';

const CACHE_VERSION  = 'v1.2.0';
const CACHE_STATIC   = `atshel-static-${CACHE_VERSION}`;
const CACHE_PAGES    = `atshel-pages-${CACHE_VERSION}`;
const CACHE_MEDIA    = `atshel-media-${CACHE_VERSION}`;

const CACHES_VALIDOS = [CACHE_STATIC, CACHE_PAGES, CACHE_MEDIA];

const ASSETS_PRECACHE = [
	// Bundles con hash generados por Vite (JS, CSS, WASM, workers)
	/* __VITE_BUILD_ASSETS__ */

	// Estáticos de public/
	'/manifest.json',
	'/css/atshel-theme.css',
	'/vendor/dompurify.min.js',
	'/vendor/phosphor-icons.min.js',
	'/vendor/jspdf.min.js',

	// Las 17 pantallas HTML declaradas en vite.config.js
	'/offline.html',
	'/login.html',
	'/setup.html',
	'/index.html',
	'/dashboard.html',
	'/incidentes.html',
	'/incidente-nuevo.html',
	'/incidente-detalle.html',
	'/incidente-investigar.html',
	'/near-miss.html',
	'/ats-nuevo.html',
	'/ats-supervisor.html',
	'/plantilla-admin.html',
	'/accion-nueva.html',
	'/accion-detalle.html',
	'/permisos.html',
	'/permiso-nuevo.html',
	'/permiso-detalle.html',
	'/conflictos.html',
];

const NEVER_CACHE_PATTERNS = [
	/supabase\.co\/auth\//,
	/supabase\.co\/rest\/v1\/rpc\//,
	/powersync\.journeyapps\.com/,
	/\/sw\.js/,
	/fn_crear_nonce/,
	/fn_verificar_pin/,
];

const SUPABASE_REST_PATTERN = /supabase\.co\/rest\/v1\//;
const STORAGE_PATTERN       = /supabase\.co\/storage\/v1\/object\/sign\//;
const STATIC_PATTERN        = /\.(js|css|wasm|woff2?|ttf|otf|eot|svg|png|webp|ico)(\?.*)?$/;

self.addEventListener('install', (event) => {
	event.waitUntil(
		Promise.all([
			caches.open(CACHE_STATIC).then((cache) =>
				Promise.allSettled(
					ASSETS_PRECACHE
						.filter((url) => !url.endsWith('.html'))
						.map((url) =>
							cache.add(url).catch((err) => {
								console.warn(`[SW] No se pudo pre-cachear estático ${url}:`, err.message);
							})
						)
				)
			),
			caches.open(CACHE_PAGES).then((cache) =>
				Promise.allSettled(
					ASSETS_PRECACHE
						.filter((url) => url.endsWith('.html'))
						.map((url) =>
							cache.add(url).catch((err) => {
								console.warn(`[SW] No se pudo pre-cachear página ${url}:`, err.message);
							})
						)
				)
			),
		]).then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then((nombres) =>
				Promise.all(
					nombres
						.filter((nombre) => !CACHES_VALIDOS.includes(nombre))
						.map((nombre) => {
							console.info(`[SW] Eliminando caché obsoleto: ${nombre}`);
							return caches.delete(nombre);
						})
				)
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	if (request.method !== 'GET' && request.method !== 'HEAD') return;
	if (!url.protocol.startsWith('http')) return;

	if (NEVER_CACHE_PATTERNS.some((p) => p.test(request.url))) return;

	if (SUPABASE_REST_PATTERN.test(request.url)) {
		event.respondWith(_networkFirst(request, CACHE_PAGES, 4000));
		return;
	}

	if (STORAGE_PATTERN.test(request.url)) {
		event.respondWith(_cacheFirstConTTL(request, CACHE_MEDIA, 3600));
		return;
	}

	if (STATIC_PATTERN.test(url.pathname)) {
		event.respondWith(_cacheFirst(request, CACHE_STATIC));
		return;
	}

	if (request.headers.get('Accept')?.includes('text/html') || url.pathname.endsWith('.html') || url.pathname === '/') {
		event.respondWith(_networkFirstHTML(request));
		return;
	}

	event.respondWith(_networkFirst(request, CACHE_STATIC, 5000));
});

async function _cacheFirst(request, cacheName) {
	const cache  = await caches.open(cacheName);
	const cached = await cache.match(request);
	if (cached) return cached;

	try {
		const response = await fetch(request);
		if (response.ok) cache.put(request, response.clone());
		return response;
	} catch {
		return new Response('Asset no disponible offline.', {
			status: 503,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}
}

async function _cacheFirstConTTL(request, cacheName, ttlSecs) {
	const cache  = await caches.open(cacheName);
	const cached = await cache.match(request);

	if (cached) {
		const fechaCache = cached.headers.get('sw-cached-at');
		if (fechaCache) {
			const edad = (Date.now() - Number(fechaCache)) / 1000;
			if (edad < ttlSecs) return cached;
			await cache.delete(request);
		}
	}

	try {
		const response = await fetch(request);
		if (response.ok) {
			const headers = new Headers(response.headers);
			headers.set('sw-cached-at', String(Date.now()));
			const responseConFecha = new Response(await response.blob(), {
				status:     response.status,
				statusText: response.statusText,
				headers,
			});
			cache.put(request, responseConFecha);
			return responseConFecha;
		}
		return response;
	} catch {
		if (cached) return cached;
		return _respuestaOffline();
	}
}

async function _networkFirst(request, cacheName, timeoutMs = 5000) {
	const cache = await caches.open(cacheName);
	try {
		const response = await Promise.race([fetch(request), _timeout(timeoutMs)]);
		if (response instanceof Error) throw response;
		if (response.ok) cache.put(request, response.clone());
		return response;
	} catch {
		const cached = await cache.match(request);
		if (cached) return cached;
		return _respuestaOffline();
	}
}

async function _networkFirstHTML(request) {
	try {
		const response = await Promise.race([fetch(request), _timeout(4000)]);
		if (response instanceof Error) throw response;
		if (response.ok) {
			const cache = await caches.open(CACHE_PAGES);
			cache.put(request, response.clone());
		}
		return response;
	} catch {
		const cache  = await caches.open(CACHE_PAGES);
		let   cached = await cache.match(request);
		if (!cached) cached = await cache.match(request, { ignoreSearch: true });
		if (cached) return cached;

		const offlinePage = await cache.match('/offline.html');
		if (offlinePage) return offlinePage;

		return new Response('<h1>Sin conexión</h1>', {
			status:  503,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	}
}

function _timeout(ms) {
	return new Promise((_, reject) =>
		setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)
	);
}

function _respuestaOffline() {
	return new Response(
		JSON.stringify({ error: 'ERR_SYS_03: Sin conexión. Reintentá cuando vuelva la señal.' }),
		{
			status:  503,
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
		}
	);
}

self.addEventListener('message', (event) => {
	const { tipo, payload } = event.data ?? {};

	switch (tipo) {
		case 'SKIP_WAITING':
			self.skipWaiting();
			break;
		case 'CLEAR_PAGE_CACHE': {
			const url = payload?.url;
			if (url) caches.open(CACHE_PAGES).then((cache) => cache.delete(url));
			break;
		}
		case 'CLEAR_MEDIA_CACHE':
			caches.delete(CACHE_MEDIA).then(() => {
				console.info('[SW] Caché de media limpiado por solicitud del cliente.');
			});
			break;
		case 'GET_VERSION':
			event.source?.postMessage({
				tipo:    'SW_VERSION',
				version: CACHE_VERSION,
			});
			break;
		default:
			console.warn('[SW] Mensaje desconocido:', tipo);
	}
});
