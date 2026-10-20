/**
 * atshel-app.js
 * Punto de entrada de ATSHEL. 9 pasos de inicialización en orden.
 * Schema y columnas verificados con MCP Supabase (2026-06-14).
 *
 * v3.1.0 — Blindaje Offline MPA, Ping CORS-Safe y Cierre de Sesión Coordinado
 *
 * Mejoras v3.1.0 sobre v3.0.0:
 *   1. _hayConexionReal() corregido: usa `/auth/v1/health` con header `apikey`
 *      para evitar falsos negativos por bloqueo CORS en Supabase Cloud.
 *   2. Inicio protegido 0ms-wait: no bloquea el arranque de cada página MPA con un
 *      ping de red de 3s; verifica internet en background solo cuando es necesario.
 *   3. Protección de sesión offline en Paso 2: si `getUsuario()` falla estando sin
 *      señal, NO ejecuta `logout()` (evita expulsar al operador en el pozo).
 *   4. `cerrarSesionApp()` exportado y expuesto en `window.ATSHEL.logout`:
 *      verifica si hay ATS/incidentes (`hasPendingCrud`) o fotos (`colaSubida`)
 *      pendientes de subir antes de cerrar sesión, espera a `closePowerSync()`
 *      y redirige sin race conditions.
 *   5. `getAppState()` con try/catch sobre `structuredClone` para evitar `DataCloneError`.
 *   6. Rutas de `NAV_POR_ROL` alineadas con las páginas reales del build de Vite.
 */

import {
	syncStatus,
	showToast,
	initHeartbeat,
	checkHeartbeat,
	renderSyncBadge,
} from './atshel-core.js';

import {
	supabase,
	ATSHELError,
	getSession,
	getUsuario,
	logout,
} from './atshel-supabase.js';

import { colaSubida } from './atshel-media.js';
import {
	initPowerSync,
	closePowerSync,
	hasPendingCrud,
	db,
} from './atshel-powersync.js';

// ─────────────────────────────────────────────────────────────
// LOGGER CENTRALIZADO
// info → solo DEV | warn/error → siempre
// ─────────────────────────────────────────────────────────────

const logger = {
	info:  import.meta.env.DEV ? (...a) => console.info('[ATSHEL:app]', ...a)  : () => {},
	warn:  (...a) => console.warn('[ATSHEL:app]', ...a),
	error: (...a) => console.error('[ATSHEL:app]', ...a),
};

// ─────────────────────────────────────────────────────────────
// DEBUG CATCHER — solo en DEV
// ─────────────────────────────────────────────────────────────

if (import.meta.env.DEV) {
	(function _atshelDebugCatcher() {
		function _mostrarError(origen, mensaje) {
			let box = document.getElementById('_atshel-debug-box');
			if (!box) {
				box = document.createElement('div');
				box.id = '_atshel-debug-box';
				box.style.cssText =
					'position:fixed;bottom:0;left:0;right:0;z-index:99999;' +
					'background:#4a0000;color:#fff;font:12px monospace;' +
					'padding:10px;max-height:40vh;overflow:auto;' +
					'border-top:3px solid red;white-space:pre-wrap;';
				document.documentElement.appendChild(box);
			}
			const linea = document.createElement('div');
			linea.style.cssText = 'margin-bottom:8px;border-bottom:1px solid #822;padding-bottom:8px;';
			linea.textContent   = '[' + origen + '] ' + mensaje;
			box.appendChild(linea);
		}

		window.addEventListener('error', (e) => {
			_mostrarError(
				'error',
				(e.message || 'error desconocido') +
				' — ' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || '')
			);
		});

		window.addEventListener('unhandledrejection', (e) => {
			const r = e.reason;
			_mostrarError('promise', r && r.stack ? r.stack : String(r));
		});

		window._atshelDebugPaso = (texto) =>
			_mostrarError('paso', texto + '  @' + new Date().toLocaleTimeString());
	})();
}

const _debugPaso = import.meta.env.DEV
	? (texto) => window._atshelDebugPaso?.(texto)
	: () => {};

// ─────────────────────────────────────────────────────────────
// SAFE HANDLER — captura errores en callbacks de DOM
// ─────────────────────────────────────────────────────────────

/**
 * Envuelve un event handler para capturar errores silenciosamente.
 * Exportado para uso en pantallas individuales.
 *
 * @param {Function} fn
 * @param {string} [contexto='handler']
 * @returns {Function}
 */
export function safeHandler(fn, contexto = 'handler') {
	return async (...args) => {
		try {
			await fn(...args);
		} catch (e) {
			logger.error(`Error en ${contexto}:`, e);
		}
	};
}

// ─────────────────────────────────────────────────────────────
// CONSTANTES Y NAVEGACIÓN ALINEADA CON VITE.CONFIG.JS
// ─────────────────────────────────────────────────────────────

const RUTAS_PUBLICAS = [
	'/login.html',
	'/offline.html',
	'/setup.html',
];

const NAV_POR_ROL = {
	hse: [
		{ id: 'nav-inicio',     href: '/index.html',         icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes', href: '/incidentes.html',    icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-ats',        href: '/ats-nuevo.html',     icono: 'clipboard-text', label: 'ATS'        },
		{ id: 'nav-permisos',   href: '/permisos.html',      icono: 'key',            label: 'Permisos'   },
		{ id: 'nav-conflictos', href: '/conflictos.html',    icono: 'arrows-clockwise', label: 'Sync'     },
	],
	supervisor: [
		{ id: 'nav-inicio',     href: '/index.html',          icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes', href: '/incidentes.html',     icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-ats',        href: '/ats-supervisor.html', icono: 'clipboard-text', label: 'ATS'        },
		{ id: 'nav-permisos',   href: '/permisos.html',       icono: 'key',            label: 'Permisos'   },
		{ id: 'nav-acciones',   href: '/accion-nueva.html',   icono: 'check-circle',   label: 'Acciones'   },
	],
	administrador: [
		{ id: 'nav-inicio',     href: '/index.html',          icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-dashboard',  href: '/dashboard.html',      icono: 'chart-bar',      label: 'Dashboard'  },
		{ id: 'nav-incidentes', href: '/incidentes.html',     icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-plantillas', href: '/plantilla-admin.html', icono: 'files',         label: 'Plantillas' },
		{ id: 'nav-permisos',   href: '/permisos.html',       icono: 'key',            label: 'Permisos'   },
	],
};

const INIT_TIMEOUT_MS    = 12_000;
const POWERSYNC_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 300_000];
const SW_UPDATE_INTERVAL = 60 * 60 * 1_000;

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL — Proxy de solo lectura externamente
// ─────────────────────────────────────────────────────────────

const _appState = {
	session:      null,
	usuario:      null,
	empresaId:    null,
	rol:          null,
	powersync:    false,
	listo:        false,
	paginaActual: window.ATSHEL_PAGE ?? _detectarPagina(),
};

let _initializando = true;
let _forzarEstado  = false;

function _setState(parcial) {
	if (!_initializando && !_forzarEstado) {
		logger.warn('_setState fuera del ciclo de init — ignorado.');
		return;
	}
	Object.assign(_appState, parcial);
}

export const AppState = new Proxy(_appState, {
	set(target, prop, value) {
		if (_initializando) {
			target[prop] = value;
			return true;
		}
		logger.warn(`AppState.${prop} es de solo lectura externamente.`);
		return false;
	},
});

// ─────────────────────────────────────────────────────────────
// window.ATSHEL — namespace público reactivo
// ─────────────────────────────────────────────────────────────

Object.defineProperty(window, 'ATSHEL', {
	value: Object.freeze({
		get db()        { return db; },
		get supabase()  { return supabase; },
		get user()      { return _appState.usuario; },
		get session()   { return _appState.session; },
		get empresaId() { return _appState.empresaId; },
		get rol()       { return _appState.rol; },
		logout:         (...args) => cerrarSesionApp(...args),
	}),
	writable:     false,
	configurable: false,
});

let _appLista        = false;
let _redireccionando = false;
let _cerrandoSesion  = false;

// ─────────────────────────────────────────────────────────────
// HANDLES DE RECURSOS — todos limpiables
// ─────────────────────────────────────────────────────────────

let _syncBadgeInterval       = null;
let _swUpdateInterval        = null;
let _powerSyncRetryHandle    = null;
let _powerSyncRunning        = false;
let _listenerSyncChange      = null;
let _listenerVisibility      = null;
let _listenerOnline          = null;
let _listenerOffline         = null;
let _listenersRedRegistrados = false;
let _unsubscribeAuth         = null;
let _swRefreshing            = false;
let _initAbortController     = new AbortController();

function _detectarPagina() {
	return window.location.pathname.split('/').pop()?.replace('.html', '') || 'index';
}

// ─────────────────────────────────────────────────────────────
// REDIRECCIÓN CENTRALIZADA
// ─────────────────────────────────────────────────────────────

function _redirect(url) {
	if (window.location.pathname === url) return;
	if (_redireccionando) {
		logger.warn(`Redirección a ${url} ignorada — ya hay una en curso.`);
		return;
	}
	_redireccionando = true;
	queueMicrotask(() => window.location.replace(url));
}

// ─────────────────────────────────────────────────────────────
// _conTimeout() — cancela timer en finally
// ─────────────────────────────────────────────────────────────

function _conTimeout(promesa, ms, mensajeError) {
	let timerId;
	const timeout = new Promise((_, reject) => {
		timerId = setTimeout(() => reject(new ATSHELError('ERR_SYS_40', mensajeError)), ms);
	});
	return Promise.race([promesa, timeout]).finally(() => clearTimeout(timerId));
}

// ─────────────────────────────────────────────────────────────
// _hayConexionReal() — verifica Internet real con header apikey (CORS-safe)
// ─────────────────────────────────────────────────────────────

async function _hayConexionReal() {
	if (!navigator.onLine) return false;
	try {
		const url    = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`;
		const ctrl   = new AbortController();
		const timer  = setTimeout(() => ctrl.abort(), 3_000);

		const res = await fetch(url, {
			method:  'GET',
			cache:   'no-store',
			headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
			signal:  ctrl.signal,
		}).finally(() => clearTimeout(timer));

		return res.ok || res.status === 401 || res.status === 404;
	} catch {
		return false;
	}
}

// ─────────────────────────────────────────────────────────────
// _checkAbortado() — verifica si el init fue cancelado
// ─────────────────────────────────────────────────────────────

function _checkAbortado() {
	if (_initAbortController.signal.aborted) {
		throw new ATSHELError('ERR_SYS_50', 'Inicialización cancelada.');
	}
}

// ─────────────────────────────────────────────────────────────
// PUNTO DE ENTRADA — readyState check
// ─────────────────────────────────────────────────────────────

function _iniciar() {
	const pathname  = window.location.pathname;
	const esPublica = RUTAS_PUBLICAS.some((r) => pathname.endsWith(r));
	esPublica ? _initPublico() : _initProtegido();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', _iniciar);
} else {
	_iniciar();
}

// ─────────────────────────────────────────────────────────────
// INICIALIZACIÓN PÚBLICA
// ─────────────────────────────────────────────────────────────

async function _initPublico() {
	if (window.location.pathname.endsWith('login.html')) {
		const session = await getSession();
		if (session) _redirect('/index.html');
	}
}

// ─────────────────────────────────────────────────────────────
// INICIALIZACIÓN PROTEGIDA — 9 PASOS (0ms OFFLINE DELAY)
// ─────────────────────────────────────────────────────────────

async function _initProtegido() {
	try {
		_initAbortController = new AbortController();

		// Verificación instantánea sin bloquear el arranque con fetch de 3s
		if (!navigator.onLine) {
			const sessionLocal = await getSession();
			if (sessionLocal) {
				logger.info('Inicio offline con sesión local.');
				showToast('Sin conexión. Trabajando en modo offline.', 'warning', 4000);
			} else {
				_redirect('/offline.html');
				throw new ATSHELError('ERR_SYS_11', 'Sin sesión local y sin conexión.');
			}
		}

		_checkAbortado();
		_debugPaso('1 verificarSesion — inicio');
		await _conTimeout(_paso1_verificarSesion(), INIT_TIMEOUT_MS, 'Timeout al verificar sesión.');
		_debugPaso('1 verificarSesion — OK');

		_checkAbortado();
		_debugPaso('2 cargarUsuario — inicio');
		await _conTimeout(_paso2_cargarUsuario(), INIT_TIMEOUT_MS, 'Timeout al cargar perfil.');
		_debugPaso('2 cargarUsuario — OK');

		_checkAbortado();
		_debugPaso('3 verificarTerminos — inicio');
		await _paso3_verificarTerminos();
		_debugPaso('3 verificarTerminos — OK');

		_checkAbortado();
		_debugPaso('4 verificarPin — inicio');
		await _paso4_verificarPin();
		_debugPaso('4 verificarPin — OK');

		_checkAbortado();
		_debugPaso('5 heartbeat — inicio');
		await _paso5_heartbeat();
		_debugPaso('5 heartbeat — OK');

		_checkAbortado();
		_debugPaso('6 serviceWorker — inicio');
		await _paso6_serviceWorker();
		_debugPaso('6 serviceWorker — OK');

		_checkAbortado();
		_debugPaso('7 powerSync — inicio');
		await _paso7_powerSync();
		_debugPaso('7 powerSync — OK');

		_checkAbortado();
		_debugPaso('8 colaSubida — inicio');
		await _paso8_colaSubida();
		_debugPaso('8 colaSubida — OK');

		_checkAbortado();
		_debugPaso('9 renderUI — inicio');
		_paso9_renderUI();
		_debugPaso('9 renderUI — OK');

		// Registrar auth state change DESPUÉS de init
		_registrarAuthStateChange();

		_setState({ listo: true });
		_appLista      = true;
		_initializando = false;

		document.dispatchEvent(new CustomEvent('atshel:ready', {
			detail: getAppState(),
		}));

	} catch (error) {
		const ignorar = ['ERR_SYS_11', 'ERR_SYS_25', 'ERR_SYS_26', 'ERR_SYS_50'];
		if (!ignorar.some((c) => error.message?.includes(c))) {
			logger.error('Error en inicialización:', error);
			_mostrarErrorInicializacion(
				error instanceof ATSHELError ? error.mensaje : error.message
			);
		}
	}
}

// ─────────────────────────────────────────────────────────────
// AUTH STATE CHANGE — detecta JWT vencido o cierre externo
// ─────────────────────────────────────────────────────────────

function _registrarAuthStateChange() {
	const { data } = supabase.auth.onAuthStateChange((event, session) => {
		if (event === 'SIGNED_OUT') {
			if (_cerrandoSesion) return; // Ya manejado por cerrarSesionApp()
			logger.warn('Sesión cerrada (SIGNED_OUT). Limpiando y redirigiendo a login.');
			detenerListeners();
			_redirect('/login.html');
		}

		if (event === 'TOKEN_REFRESHED' && session) {
			logger.info('JWT renovado.');
			_forzarEstado = true;
			_setState({ session });
			_forzarEstado = false;
		}
	});

	_unsubscribeAuth = data.subscription.unsubscribe;
}

// ─────────────────────────────────────────────────────────────
// PASO 1 — Verificar sesión
// ─────────────────────────────────────────────────────────────

async function _paso1_verificarSesion() {
	const session = await getSession();
	if (!session) {
		_redirect('/login.html');
		throw new ATSHELError('ERR_SYS_11', 'Sin sesión activa.');
	}
	_setState({ session });
}

// ─────────────────────────────────────────────────────────────
// PASO 2 — Cargar usuario (Resiliente Offline)
// ─────────────────────────────────────────────────────────────

async function _paso2_cargarUsuario() {
	const usuario = await getUsuario();

	if (!usuario) {
		// Si estamos sin señal en el pozo, NUNCA destruir la sesión con logout()
		if (!navigator.onLine) {
			logger.warn('Sin conexión y sin caché local de perfil. Mostrando pantalla offline.');
			_redirect('/offline.html');
			throw new ATSHELError('ERR_SYS_11', 'Perfil no disponible offline.');
		}

		logger.error('ERR_SYS_23: Sin fila en public.usuarios.');
		showToast('Error al cargar tu perfil. Contactá al administrador.', 'error', 6000);
		await logout();
		_redirect('/login.html');
		throw new ATSHELError('ERR_SYS_23', 'Perfil incompleto.');
	}

	const empresaId = usuario.empresa_id ?? null;
	const rol       = usuario.rol        ?? null;

	if (!empresaId) {
		logger.warn('Sin empresa — redirigiendo a setup de empresa.');
		_redirect('/setup.html?paso=empresa');
		throw new ATSHELError('ERR_SYS_26', 'Sin empresa asignada.');
	}

	if (!rol) {
		logger.error('ERR_SYS_27: Sin rol asignado.');
		showToast('Tu cuenta no tiene rol asignado. Contactá al administrador.', 'error', 6000);
		await logout();
		_redirect('/login.html');
		throw new ATSHELError('ERR_SYS_27', 'Sin rol asignado.');
	}

	if (!usuario.activo) {
		showToast('Tu cuenta está desactivada. Contactá al administrador.', 'error', 6000);
		await logout();
		_redirect('/login.html');
		throw new ATSHELError('ERR_SYS_24', 'Cuenta desactivada.');
	}

	_setState({ usuario, empresaId, rol });
}

// ─────────────────────────────────────────────────────────────
// PASO 3 — Verificar términos
// ─────────────────────────────────────────────────────────────

async function _paso3_verificarTerminos() {
	if (!_appState.usuario.terminos_aceptado_en) {
		_redirect('/setup.html?paso=terminos');
		throw new ATSHELError('ERR_SYS_25', 'Términos no aceptados.');
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 4 — PIN (diferido al momento de firma)
// ─────────────────────────────────────────────────────────────

async function _paso4_verificarPin() {
	if (window.location.pathname.endsWith('setup.html')) return;
}

// ─────────────────────────────────────────────────────────────
// PASO 5 — Heartbeat dual + visibilitychange
// ─────────────────────────────────────────────────────────────

async function _paso5_heartbeat() {
	const { perdido, ultimoLS } = await checkHeartbeat();
	if (perdido && ultimoLS) _mostrarModalIDBPerdido(new Date(ultimoLS));

	await initHeartbeat();

	_listenerVisibility = safeHandler(async () => {
		if (document.visibilityState === 'visible') {
			const { perdido: p, ultimoLS: u } = await checkHeartbeat();
			if (p && u) _mostrarModalIDBPerdido(new Date(u));
		}
	}, 'visibilitychange');

	document.addEventListener('visibilitychange', _listenerVisibility);
}

function _mostrarModalIDBPerdido(ultimaActividad) {
	if (document.getElementById('modal-idb')) return;

	const modal = document.createElement('div');
	modal.id = 'modal-idb';
	modal.setAttribute('role', 'alertdialog');
	modal.setAttribute('aria-modal', 'true');
	modal.setAttribute('aria-labelledby', 'modal-idb-titulo');
	Object.assign(modal.style, {
		position: 'fixed', inset: '0',
		background: 'rgba(0,0,0,0.7)',
		display: 'flex', alignItems: 'center', justifyContent: 'center',
		zIndex: '9999', padding: '24px',
	});

	const contenedor = document.createElement('div');
	Object.assign(contenedor.style, {
		background: '#1F252D', border: '1px solid rgba(249,115,22,0.3)',
		borderRadius: '12px', padding: '24px', maxWidth: '360px', width: '100%',
	});

	const titulo = document.createElement('p');
	titulo.id = 'modal-idb-titulo';
	titulo.style.cssText = 'font-size:17px;font-weight:700;color:#F97316;margin-bottom:12px;';
	titulo.textContent = '⚠ Datos locales eliminados';

	const cuerpo = document.createElement('p');
	cuerpo.style.cssText = 'font-size:15px;color:#8B98A8;line-height:1.5;margin-bottom:20px;';
	cuerpo.textContent = `El sistema operativo liberó espacio. Tu última actividad fue el ${
		ultimaActividad?.toLocaleString('es-AR') ?? 'fecha desconocida'
	}. Los datos sincronizados están seguros en el servidor.`;

	const btn = document.createElement('button');
	btn.style.cssText =
		'width:100%;height:52px;background:#FFC107;color:#0A0C0E;' +
		'border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;';
	btn.textContent = 'Entendido';
	btn.autofocus   = true;

	contenedor.appendChild(titulo);
	contenedor.appendChild(cuerpo);
	contenedor.appendChild(btn);
	modal.appendChild(contenedor);
	document.body.appendChild(modal);

	btn.addEventListener('click', () => modal.remove(), { once: true });
	requestAnimationFrame(() => btn.focus());
}

// ─────────────────────────────────────────────────────────────
// PASO 6 — Service Worker
// ─────────────────────────────────────────────────────────────

async function _paso6_serviceWorker() {
	if (!('serviceWorker' in navigator)) {
		logger.warn('Service Worker no disponible.');
		return;
	}

	try {
		const registro = await navigator.serviceWorker.register('/sw.js', {
			scope:          '/',
			updateViaCache: 'none',
		});

		registro.addEventListener('updatefound', () => {
			const nuevoSW = registro.installing;
			nuevoSW?.addEventListener('statechange', () => {
				if (nuevoSW.state === 'installed' && navigator.serviceWorker.controller) {
					showToast('Nueva versión disponible. Actualizando...', 'info', 4000);
				}
			});
		});

		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (_swRefreshing) return;
			_swRefreshing = true;
			logger.info('Nuevo SW activo. Recargando.');
			window.location.reload();
		});

		_swUpdateInterval = setInterval(() => {
			registro.update().catch((e) =>
				logger.warn('SW update check falló:', e.message)
			);
		}, SW_UPDATE_INTERVAL);

	} catch (error) {
		logger.warn('Error al registrar Service Worker:', error.message);
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 7 — PowerSync con retry exponencial cancelable
// ─────────────────────────────────────────────────────────────

async function _paso7_powerSync(intentoActual = 0) {
	if (_powerSyncRunning) {
		logger.warn('PowerSync ya iniciando — ignorando llamada duplicada.');
		return;
	}

	if (_powerSyncRetryHandle) {
		clearTimeout(_powerSyncRetryHandle);
		_powerSyncRetryHandle = null;
	}

	_powerSyncRunning = true;

	try {
		await initPowerSync();
		_forzarEstado = true;
		_setState({ powersync: true });
		_forzarEstado = false;
		logger.info('PowerSync SQLite local activo.');

	} catch (error) {
		logger.warn(`PowerSync intento ${intentoActual + 1} falló:`, error.message);
		_forzarEstado = true;
		_setState({ powersync: false });
		_forzarEstado = false;
		syncStatus.actualizar({ estado: 'desconectado' });

		if (intentoActual === 0) {
			showToast(
				'Sin sincronización automática. Los datos se guardan cuando haya señal.',
				'warning',
				5000
			);
		}

		const espera     = POWERSYNC_RETRY_MS[intentoActual] ?? POWERSYNC_RETRY_MS.at(-1);
		const sigIntento = Math.min(intentoActual + 1, POWERSYNC_RETRY_MS.length - 1);

		_powerSyncRetryHandle = setTimeout(() => {
			_powerSyncRunning = false;
			_paso7_powerSync(sigIntento);
		}, espera);

	} finally {
		if (!_powerSyncRetryHandle) _powerSyncRunning = false;
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 8 — Cola de subida (no bloquea el renderizado de la UI)
// ─────────────────────────────────────────────────────────────

async function _paso8_colaSubida() {
	if (!navigator.onLine) return;

	// Ejecutar verificación y subida en background sin retrasar el Paso 9
	(async () => {
		try {
			const pendientes = await colaSubida.pendientes();
			if (pendientes > 0 && (await _hayConexionReal())) {
				await colaSubida.procesar();
			}
		} catch (error) {
			logger.warn('Error al procesar cola de subida en background:', error.message);
		}
	})();
}

// ─────────────────────────────────────────────────────────────
// PASO 9 — Renderizar UI según rol
// ─────────────────────────────────────────────────────────────

function _paso9_renderUI() {
	const { rol, usuario } = _appState;

	_renderNav(rol);
	_renderHeader(usuario);
	_marcarNavActiva();

	if (usuario.es_nuevo_ingresante) _mostrarBadgeNuevoIngresante();

	_iniciarSyncBadgeUpdater();
}

function _renderNav(rol) {
	const nav = document.querySelector('.app-nav');
	if (!nav) return;

	const items = NAV_POR_ROL[rol] ?? NAV_POR_ROL.hse;

	nav.innerHTML = items.map((item) => `
		<a id="${item.id}" href="${item.href}" class="nav-item" aria-label="${item.label}">
			<i class="ph ph-${item.icono} nav-item__icon" aria-hidden="true"></i>
			<span class="nav-item__label">${item.label}</span>
		</a>
	`).join('');
}

function _marcarNavActiva() {
	const rutaActual = window.location.pathname;
	document.querySelectorAll('.nav-item').forEach((item) => {
		const href = item.getAttribute('href') ?? '';
		if (rutaActual.endsWith(href) || (href === '/index.html' && rutaActual === '/')) {
			item.classList.add('nav-item--active');
			item.setAttribute('aria-current', 'page');
		}
	});
}

function _renderHeader(usuario) {
	const nombreEl = document.getElementById('header-usuario-nombre');
	if (nombreEl && usuario?.nombre_completo) {
		nombreEl.textContent = usuario.nombre_completo;
	}
	renderSyncBadge();
}

function _mostrarBadgeNuevoIngresante() {
	const badge = document.getElementById('badge-nuevo-ingresante');
	if (!badge) return;
	badge.textContent   = 'Nuevo ingresante';
	badge.className     = 'badge badge--warning';
	badge.style.display = 'inline-flex';
}

// ─────────────────────────────────────────────────────────────
// SYNC BADGE UPDATER
// ─────────────────────────────────────────────────────────────

function _iniciarSyncBadgeUpdater() {
	if (_syncBadgeInterval) clearInterval(_syncBadgeInterval);
	if (_listenerSyncChange) {
		document.removeEventListener('syncStatus:change', _listenerSyncChange);
	}

	renderSyncBadge();
	_syncBadgeInterval  = setInterval(renderSyncBadge, 10_000);
	_listenerSyncChange = () => renderSyncBadge();
	document.addEventListener('syncStatus:change', _listenerSyncChange);

	if (!_listenersRedRegistrados) {
		_listenerOnline = safeHandler(async () => {
			const real = await _hayConexionReal();
			if (real) {
				syncStatus.actualizar({ estado: 'sincronizando' });
				renderSyncBadge();
				document.dispatchEvent(new Event('syncStatus:change'));
				// Al recuperar señal en el yacimiento, vaciar cola de fotos pendientes
				const pendientes = await colaSubida.pendientes().catch(() => 0);
				if (pendientes > 0) colaSubida.procesar().catch(() => {});
			}
		}, 'online');

		_listenerOffline = safeHandler(async () => {
			syncStatus.actualizar({ estado: 'desconectado' });
			renderSyncBadge();
			document.dispatchEvent(new Event('syncStatus:change'));
		}, 'offline');

		window.addEventListener('online',  _listenerOnline);
		window.addEventListener('offline', _listenerOffline);
		_listenersRedRegistrados = true;
	}
}

// ─────────────────────────────────────────────────────────────
// ERROR DE INICIALIZACIÓN — textContent, sin XSS
// ─────────────────────────────────────────────────────────────

function _mostrarErrorInicializacion(mensaje) {
	const contenido = document.querySelector('.app-content');
	if (!contenido) return;

	contenido.innerHTML = '';

	const wrapper = document.createElement('div');
	wrapper.className        = 'empty-state';
	wrapper.style.paddingTop = '80px';

	const icono = document.createElement('div');
	icono.className   = 'empty-state__icon';
	icono.textContent = '⚠';

	const titulo = document.createElement('p');
	titulo.className   = 'empty-state__title';
	titulo.textContent = 'Error al iniciar';

	const desc = document.createElement('p');
	desc.className   = 'empty-state__desc';
	desc.textContent = mensaje ?? 'Ocurrió un error inesperado.';

	const btn = document.createElement('button');
	btn.className     = 'btn btn--primary btn--full';
	btn.style.cssText = 'margin-top:24px;max-width:280px;';
	btn.textContent   = 'Reintentar';
	btn.addEventListener('click', safeHandler(() => window.location.reload(), 'reintentar'), { once: true });

	wrapper.appendChild(icono);
	wrapper.appendChild(titulo);
	wrapper.appendChild(desc);
	wrapper.appendChild(btn);
	contenido.appendChild(wrapper);
}

// ─────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────

/**
 * Cierra la sesión de forma segura coordinando PowerSync, Cola de Media y Supabase Auth.
 * Si existen datos o fotos creados offline aún sin subir, advierte al usuario antes de salir.
 *
 * @param {{ forzar?: boolean }} [opciones]
 * @returns {Promise<boolean>} false si el usuario canceló el cierre de sesión
 */
export async function cerrarSesionApp({ forzar = false } = {}) {
	if (_cerrandoSesion) return false;

	try {
		if (!forzar) {
			const [hayCrudPendiente, fotosPendientes] = await Promise.all([
				hasPendingCrud().catch(() => false),
				colaSubida.pendientes().catch(() => 0),
			]);

			if (hayCrudPendiente || fotosPendientes > 0) {
				const confirmar = window.confirm(
					'Tenés registros o fotos guardados en el dispositivo que aún no se sincronizaron con el servidor.\n\n' +
					'¿Querés cerrar sesión de todos modos? (Los datos pendientes se conservarán hasta que vuelva la señal).'
				);
				if (!confirmar) return false;
			}
		}

		_cerrandoSesion = true;
		detenerListeners();

		await closePowerSync({ forceClear: forzar });
		await logout();

		_redirect('/login.html');
		return true;

	} catch (error) {
		logger.error('Error en cerrarSesionApp:', error);
		_redirect('/login.html');
		return true;
	}
}

/**
 * Ejecuta callback cuando la app está lista.
 * Si ya inició, ejecuta inmediatamente.
 *
 * @param {(state: object) => void} callback
 */
export function onReady(callback) {
	if (_appLista) {
		callback(getAppState());
		return;
	}
	document.addEventListener('atshel:ready', (e) => callback(e.detail), { once: true });
}

/**
 * Retorna copia profunda del estado — blindado contra DataCloneError.
 *
 * @returns {object}
 */
export function getAppState() {
	try {
		if (typeof structuredClone === 'function') {
			return structuredClone(_appState);
		}
	} catch {
		// Fallback silencioso si Session contiene referencias no clonables
	}
	return JSON.parse(JSON.stringify(_appState));
}

/**
 * Verifica acceso por rol.
 * Roles válidos MCP: 'administrador' | 'supervisor' | 'hse'
 *
 * @param {...string} rolesPermitidos
 * @returns {boolean}
 */
export function verificarAcceso(...rolesPermitidos) {
	if (!rolesPermitidos.includes(_appState.rol)) {
		showToast('No tenés acceso a esta sección.', 'error');
		setTimeout(() => _redirect('/index.html'), 1500);
		return false;
	}
	return true;
}

/**
 * Detiene interval y listener del sync badge.
 */
export function detenerSyncBadge() {
	if (_syncBadgeInterval) {
		clearInterval(_syncBadgeInterval);
		_syncBadgeInterval = null;
	}
	if (_listenerSyncChange) {
		document.removeEventListener('syncStatus:change', _listenerSyncChange);
		_listenerSyncChange = null;
	}
}

/**
 * Limpia TODOS los recursos de la app.
 */
export function detenerListeners() {
	detenerSyncBadge();

	_initAbortController.abort();

	if (_listenerVisibility) {
		document.removeEventListener('visibilitychange', _listenerVisibility);
		_listenerVisibility = null;
	}
	if (_listenerOnline) {
		window.removeEventListener('online', _listenerOnline);
		_listenerOnline = null;
	}
	if (_listenerOffline) {
		window.removeEventListener('offline', _listenerOffline);
		_listenerOffline = null;
	}
	if (_powerSyncRetryHandle) {
		clearTimeout(_powerSyncRetryHandle);
		_powerSyncRetryHandle = null;
	}
	if (_swUpdateInterval) {
		clearInterval(_swUpdateInterval);
		_swUpdateInterval = null;
	}
	if (_unsubscribeAuth) {
		_unsubscribeAuth();
		_unsubscribeAuth = null;
	}

	_powerSyncRunning        = false;
	_listenersRedRegistrados = false;

	logger.info('Todos los listeners y recursos limpiados.');
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-app.js v3.1.0
// ─────────────────────────────────────────────────────────────
