/**
 * sw.js — Service Worker de ATSHEL
 * Versión: 1.0.0
 *
 * Estrategias de caché:
 *   · Assets estáticos (JS, CSS, vendor, icons): Cache-First con versión
 *   · HTML de pantallas:                         Network-First con fallback a caché
 *   · Supabase REST/Auth:                        Network-Only (sin caché — datos sensibles)
 *   · PowerSync WebSocket/WASM:                  Network-Only (maneja su propia persistencia)
 *   · Supabase Storage (fotos):                  Cache-First con expiración 1h
 *   · Fuera de línea:                            Fallback a /offline.html
 *
 * IMPORTANTE:
 *   · Los nonces de firma PIN nunca se cachean.
 *   · Las respuestas de Auth nunca se cachean.
 *   · El SW nunca almacena tokens JWT ni claves.
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. VERSIÓN Y NOMBRES DE CACHÉ
//    Cambiar CACHE_VERSION fuerza la renovación de todos los caches.
// ─────────────────────────────────────────────────────────────

const CACHE_VERSION    = 'v1.1.0';
const CACHE_STATIC     = `atshel-static-${CACHE_VERSION}`;
const CACHE_PAGES      = `atshel-pages-${CACHE_VERSION}`;
const CACHE_MEDIA      = `atshel-media-${CACHE_VERSION}`;

const CACHES_VALIDOS   = [CACHE_STATIC, CACHE_PAGES, CACHE_MEDIA];

// ─────────────────────────────────────────────────────────────
// 2. ASSETS ESTÁTICOS — pre-cachear en install
//    Solo archivos que sabemos que existen en el build.
//    El SW falla si alguno no existe — ser conservador.
// ─────────────────────────────────────────────────────────────

const ASSETS_PRECACHE = [
	// CSS
	'/css/atshel-theme.css',

	// JS core
	'/js/atshel-core.js',
	'/js/atshel-supabase.js',
	'/js/atshel-media.js',
	'/js/atshel-powersync.js',
	'/js/atshel-app.js',

	// Vendor
	'/vendor/dompurify.min.js',
	'/vendor/phosphor-icons.min.js',
	'/vendor/jspdf.min.js',

	// Pantallas de acceso — necesarias antes de tener sesión
	'/offline.html',
	'/login.html',
	'/setup.html',
	'/index.html',

	// Pantallas de trabajo — v1.1.0 (2026-08-19): antes solo se
	// cacheaban recién en la primera visita online (_networkFirstHTML
	// las agrega a CACHE_PAGES cuando responden ok). Si un técnico
	// nunca había abierto una pantalla estando online, la primera vez
	// que la pedía sin señal cae directo a offline.html — no porque
	// falte conexión, sino porque no había nada en caché todavía.
	// Precachear acá las pantallas centrales evita ese falso negativo
	// desde la primera vez que se instala la PWA.
	'/dashboard.html',
	'/incidentes.html',
	'/incidente-nuevo.html',
	'/incidente-detalle.html',
	'/accion-nueva.html',
	'/accion-detalle.html',
	'/permisos.html',
];

// ─────────────────────────────────────────────────────────────
// 3. REGLAS DE ENRUTAMIENTO
// ─────────────────────────────────────────────────────────────

// URLs que NUNCA se cachean — datos sensibles o con estado de servidor
const NEVER_CACHE_PATTERNS = [
	/supabase\.co\/auth\//,              // Auth endpoints
	/supabase\.co\/rest\/v1\/rpc\//,     // RPC calls (nonces, PIN, etc.)
	/powersync\.journeyapps\.com/,       // PowerSync (maneja su propia sync)
	/\/sw\.js/,                          // El SW nunca se cacha a sí mismo
	/fn_crear_nonce/,                    // Nonces de firma
	/fn_verificar_pin/,                  // Verificación PIN
];

// URLs de Supabase REST que van Network-First (datos de negocio)
const SUPABASE_REST_PATTERN = /supabase\.co\/rest\/v1\//;

// URLs de Storage que van Cache-First (fotos ya subidas)
const STORAGE_PATTERN = /supabase\.co\/storage\/v1\/object\/sign\//;

// Archivos JS/CSS/vendor — Cache-First
const STATIC_PATTERN = /\.(js|css|woff2?|ttf|otf|eot)(\?.*)?$/;

// ─────────────────────────────────────────────────────────────
// 4. INSTALL — Pre-cachear assets críticos
// ─────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_STATIC)
			.then((cache) => {
				// addAll falla si cualquier asset falla — usar add individual
				// para que assets faltantes no rompan el install completo
				return Promise.allSettled(
					ASSETS_PRECACHE.map((url) =>
						cache.add(url).catch((err) => {
							console.warn(`[SW] No se pudo pre-cachear ${url}:`, err.message);
						})
					)
				);
			})
			.then(() => {
				// Activar inmediatamente sin esperar a que los tabs actuales cierren
				return self.skipWaiting();
			})
	);
});

// ─────────────────────────────────────────────────────────────
// 5. ACTIVATE — Limpiar cachés viejos
// ─────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then((nombres) => {
				return Promise.all(
					nombres
						.filter((nombre) => !CACHES_VALIDOS.includes(nombre))
						.map((nombre) => {
							console.info(`[SW] Eliminando caché obsoleto: ${nombre}`);
							return caches.delete(nombre);
						})
				);
			})
			.then(() => {
				// Tomar control de todos los tabs abiertos inmediatamente
				return self.clients.claim();
			})
	);
});

// ─────────────────────────────────────────────────────────────
// 6. FETCH — Enrutador de estrategias
// ─────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Solo interceptar GET y HEAD — POST/PUT/DELETE van directo a la red
	if (request.method !== 'GET' && request.method !== 'HEAD') return;

	// Ignorar requests de extensiones de browser o protocolos no-http
	if (!url.protocol.startsWith('http')) return;

	// ── NUNCA CACHEAR ─────────────────────────────────────────
	if (NEVER_CACHE_PATTERNS.some((p) => p.test(request.url))) {
		// Network-Only: ir a la red directamente, sin fallback
		return;
	}

	// ── SUPABASE REST (datos de negocio) — Network-First ──────
	if (SUPABASE_REST_PATTERN.test(request.url)) {
		event.respondWith(_networkFirst(request, CACHE_PAGES, 4000));
		return;
	}

	// ── STORAGE (fotos firmadas) — Cache-First con TTL 1h ─────
	if (STORAGE_PATTERN.test(request.url)) {
		event.respondWith(_cacheFirstConTTL(request, CACHE_MEDIA, 3600));
		return;
	}

	// ── ARCHIVOS ESTÁTICOS (JS, CSS, vendor) — Cache-First ────
	if (STATIC_PATTERN.test(url.pathname)) {
		event.respondWith(_cacheFirst(request, CACHE_STATIC));
		return;
	}

	// ── HTML DE PANTALLAS — Network-First con fallback ────────
	if (request.headers.get('Accept')?.includes('text/html')) {
		event.respondWith(_networkFirstHTML(request));
		return;
	}

	// ── RESTO — Network con fallback a caché ──────────────────
	event.respondWith(_networkFirst(request, CACHE_STATIC, 5000));
});

// ─────────────────────────────────────────────────────────────
// 7. ESTRATEGIAS DE CACHÉ
// ─────────────────────────────────────────────────────────────

/**
 * Cache-First: busca en caché, si no encuentra va a la red y guarda.
 * Para assets estáticos con URL versionada.
 */
async function _cacheFirst(request, cacheName) {
	const cache    = await caches.open(cacheName);
	const cached   = await cache.match(request);

	if (cached) return cached;

	try {
		const response = await fetch(request);
		if (response.ok) {
			cache.put(request, response.clone());
		}
		return response;
	} catch {
		return new Response('Asset no disponible offline.', {
			status: 503,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}
}

/**
 * Cache-First con TTL: igual que cacheFirst pero verifica expiración.
 * Para URLs firmadas de Storage (expiran en 1h).
 */
async function _cacheFirstConTTL(request, cacheName, ttlSecs) {
	const cache  = await caches.open(cacheName);
	const cached = await cache.match(request);

	if (cached) {
		const fechaCache = cached.headers.get('sw-cached-at');
		if (fechaCache) {
			const edad = (Date.now() - Number(fechaCache)) / 1000;
			if (edad < ttlSecs) return cached;
			// Expirado — borrar y buscar en red
			await cache.delete(request);
		}
	}

	try {
		const response = await fetch(request);
		if (response.ok) {
			// Agregar header de timestamp antes de cachear
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
		if (cached) return cached; // Devolver expirado si no hay red
		return _respuestaOffline();
	}
}

/**
 * Network-First: intenta la red, si falla usa caché.
 * Con timeout para no bloquear en campo con señal lenta.
 */
async function _networkFirst(request, cacheName, timeoutMs = 5000) {
	const cache = await caches.open(cacheName);

	try {
		const response = await Promise.race([
			fetch(request),
			_timeout(timeoutMs),
		]);

		if (response instanceof Error) throw response;

		if (response.ok) {
			cache.put(request, response.clone());
		}

		return response;
	} catch {
		const cached = await cache.match(request);
		if (cached) return cached;
		return _respuestaOffline();
	}
}

/**
 * Network-First para HTML con fallback a /offline.html.
 */
async function _networkFirstHTML(request) {
	try {
		const response = await Promise.race([
			fetch(request),
			_timeout(4000),
		]);

		if (response instanceof Error) throw response;

		if (response.ok) {
			const cache = await caches.open(CACHE_PAGES);
			cache.put(request, response.clone());
		}

		return response;

	} catch {
		// Buscar en caché de páginas
		const cache  = await caches.open(CACHE_PAGES);
		const cached = await cache.match(request);
		if (cached) return cached;

		// Fallback a offline.html
		const offlinePage = await caches.match('/offline.html');
		if (offlinePage) return offlinePage;

		return new Response('<h1>Sin conexión</h1>', {
			status:  503,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	}
}

/**
 * Promesa que rechaza después de timeoutMs.
 * Evita que fetch bloquee indefinidamente en campo con señal débil.
 */
function _timeout(ms) {
	return new Promise((_, reject) =>
		setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)
	);
}

/**
 * Respuesta estándar para cuando no hay red ni caché.
 */
function _respuestaOffline() {
	return new Response(
		JSON.stringify({ error: 'ERR_SYS_03: Sin conexión. Reintentá cuando vuelva la señal.' }),
		{
			status:  503,
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
		}
	);
}

// ─────────────────────────────────────────────────────────────
// 8. MENSAJES DESDE EL CLIENTE
//    El cliente puede enviar mensajes al SW via postMessage.
// ─────────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
	const { tipo, payload } = event.data ?? {};

	switch (tipo) {

		// Cliente pide al SW que se active inmediatamente
		case 'SKIP_WAITING':
			self.skipWaiting();
			break;

		// Cliente pide limpiar caché de una pantalla específica
		case 'CLEAR_PAGE_CACHE': {
			const url = payload?.url;
			if (url) {
				caches.open(CACHE_PAGES).then((cache) => cache.delete(url));
			}
			break;
		}

		// Cliente pide limpiar todo el caché de media (fotos expiradas)
		case 'CLEAR_MEDIA_CACHE':
			caches.delete(CACHE_MEDIA).then(() => {
				console.info('[SW] Caché de media limpiado por solicitud del cliente.');
			});
			break;

		// Cliente pide la versión actual del SW
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

// ─────────────────────────────────────────────────────────────
// FIN DE sw.js
// ─────────────────────────────────────────────────────────────
  
