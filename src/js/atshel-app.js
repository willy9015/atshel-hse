/**
 * atshel-app.js
 * Punto de entrada de ATSHEL. 9 pasos de inicialización en orden.
 * Schema y columnas verificados con MCP Supabase (2026-06-14).
 *
 * v3.0.0 — 2026-07-29
 *
 * Cambios sobre el original:
 *   1. Debug catcher solo en DEV — nunca llega a producción.
 *   2. Logger centralizado: info solo DEV, warn/error siempre.
 *   3. ATSHELError integrado — manejo de errores unificado con supabase.js.
 *   4. readyState check — funciona aunque el script cargue tarde.
 *   5. _redirect() centralizado con queueMicrotask + guard de pathname.
 *   6. _conTimeout() con AbortController que cancela el timer en finally.
 *   7. AbortController de init — cancela si el usuario hace logout.
 *   8. PASO 2: una sola query getUsuario() — empresa_id y rol del objeto.
 *      Sin consultas duplicadas al backend.
 *   9. PASO 2: manejo separado de usuario sin empresa (→ /registro.html).
 *  10. PASO 5: visibilitychange para verificar heartbeat al volver.
 *  11. PASO 5: modal IDB con autofocus, textContent (sin XSS), id único.
 *  12. PASO 6: SW update cada 60 min + controllerchange con flag anti-loop.
 *  13. PASO 7: retry exponencial cancelable de PowerSync.
 *  14. PASO 7: flag _powerSyncRunning evita reintentos simultáneos.
 *  15. PASO 8: _hayConexionReal() para verificar red real antes de cola.
 *  16. onAuthStateChange: detecta JWT vencido → limpia estado y redirige.
 *  17. logout() de supabase.js ya no redirige — la redirección la hace app.js.
 *  18. Sync badge: interval + evento syncStatus:change + listeners removibles.
 *  19. _swUpdateInterval, _listenerVisibility, _listenerSyncChange, online/offline
 *      — todos limpiables desde detenerListeners().
 *  20. AppState: Proxy de solo lectura + _setState() centralizado.
 *  21. getAppState() retorna structuredClone con fallback para WebViews antiguos.
 *  22. onReady(): ejecuta inmediatamente si la app ya inició.
 *  23. _mostrarErrorInicializacion(): textContent, sin XSS.
 *  24. safeHandler() exportado para event listeners de pantallas.
 *  25. RUTAS_PUBLICAS incluye /registro.html y /setup.html.
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
	invalidarCacheUsuario,
} from './atshel-supabase.js';

import { colaSubida } from './atshel-media.js';
import { initPowerSync, db } from './atshel-powersync.js';

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
// CONSTANTES
// ─────────────────────────────────────────────────────────────

const RUTAS_PUBLICAS = [
	'/login.html',
	'/offline.html',
	'/registro.html',
	'/setup.html',
];

const NAV_POR_ROL = {
	hse: [
		{ id: 'nav-inicio',     href: '/index.html',          icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes', href: '/incidentes.html',     icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-ats',        href: '/ats-nuevo.html',      icono: 'clipboard-text', label: 'ATS'        },
		{ id: 'nav-permisos',   href: '/permisos.html',       icono: 'key',            label: 'Permisos'   },
		{ id: 'nav-perfil',     href: '/perfil.html',         icono: 'user-circle',    label: 'Perfil'     },
	],
	supervisor: [
		{ id: 'nav-inicio',     href: '/index.html',          icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes', href: '/incidentes.html',     icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-ats',        href: '/ats-supervisor.html', icono: 'clipboard-text', label: 'ATS'        },
		{ id: 'nav-acciones',   href: '/acciones.html',       icono: 'check-circle',   label: 'Acciones'   },
		{ id: 'nav-perfil',     href: '/perfil.html',         icono: 'user-circle',    label: 'Perfil'     },
	],
	administrador: [
		{ id: 'nav-inicio',     href: '/index.html',          icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes', href: '/incidentes.html',     icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-dashboard',  href: '/dashboard.html',      icono: 'chart-bar',      label: 'Dashboard'  },
		{ id: 'nav-equipos',    href: '/equipos.html',        icono: 'wrench',         label: 'Equipos'    },
		{ id: 'nav-perfil',     href: '/perfil.html',         icono: 'user-circle',    label: 'Perfil'     },
	],
};

const INIT_TIMEOUT_MS    = 12_000;
const POWERSYNC_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 300_000];
const SW_UPDATE_INTERVAL = 60 * 60 * 1_000;

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL — Proxy de solo lectura externamente
// Mutaciones internas via _setState()
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

let _initializando   = true;
let _forzarEstado    = false;

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
// window.ATSHEL — namespace público para páginas que leen datos
// localmente (patrón "PowerSync primero, Supabase de respaldo",
// como dbCount()/dbRows() en index.html).
//
// Getters, no snapshot: siempre reflejan el estado actual aunque
// PowerSync recién conecte en un reintento en segundo plano
// (_paso7_powerSync reintenta con backoff sin bloquear el resto
// del init).
//
// Agregado 2026-08-20 — index.html ya esperaba window.ATSHEL.db /
// .supabase / .user desde que se escribió, pero nunca se creó acá.
// window.ATSHEL era undefined siempre → todo lo que dependía de él
// (estadísticas, saludo, actividad reciente) se quedaba en su
// placeholder "—" para siempre, sin error visible.
// ─────────────────────────────────────────────────────────────
Object.defineProperty(window, 'ATSHEL', {
	value: Object.freeze({
		get db()        { return db; },
		get supabase()  { return supabase; },
		get user()      { return _appState.usuario; },
		get session()   { return _appState.session; },
		get empresaId() { return _appState.empresaId; },
		get rol()       { return _appState.rol; },
	}),
	writable:     false,
	configurable: false,
});

let _appLista         = false;
let _redireccionando  = false;

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
let _swRefreshing            = false; // anti-loop en controllerchange
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
// _hayConexionReal() — verifica Internet real, no solo interfaz
// ─────────────────────────────────────────────────────────────

async function _hayConexionReal() {
	if (!navigator.onLine) return false;
	try {
		// Usar el propio endpoint de Supabase como ping — siempre existe
		const url = `${import.meta.env.VITE_SUPABASE_URL}/health`;
		const res = await fetch(url, {
			method: 'HEAD',
			cache:  'no-store',
			signal: AbortSignal.timeout ? AbortSignal.timeout(3_000) : undefined,
		});
		return res.ok || res.status === 404; // 404 significa que el servidor responde
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
	const esPublica = RUTAS_PUBLICAS.some((r) => window.location.pathname.endsWith(r));
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
// INICIALIZACIÓN PROTEGIDA — 9 PASOS
// ─────────────────────────────────────────────────────────────

async function _initProtegido() {
	try {
		_initAbortController = new AbortController();

		// Detección offline real antes de cualquier query
		const hayRed = await _hayConexionReal();
		if (!hayRed) {
			const sessionLocal = await getSession();
			if (sessionLocal) {
				logger.info('Inicio offline con sesión local.');
				showToast('Sin conexión. Trabajando en modo offline.', 'warning', 5000);
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
			detail: { ..._appState },
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
// AUTH STATE CHANGE — detecta JWT vencido en sesión activa
// ─────────────────────────────────────────────────────────────

function _registrarAuthStateChange() {
	const { data } = supabase.auth.onAuthStateChange((event, session) => {
		if (event === 'SIGNED_OUT') {
			logger.warn('Sesión cerrada por Supabase (JWT vencido o logout remoto).');
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
// PASO 2 — Cargar usuario (UNA sola query)
// empresa_id y rol salen del objeto — sin consultas duplicadas.
// ─────────────────────────────────────────────────────────────

async function _paso2_cargarUsuario() {
	const usuario = await getUsuario();

	if (!usuario) {
		logger.error('ERR_SYS_23: Sin fila en public.usuarios.');
		showToast('Error al cargar tu perfil. Contactá al administrador.', 'error', 6000);
		await logout();
		_redirect('/login.html');
		throw new ATSHELError('ERR_SYS_23', 'Perfil incompleto.');
	}

	const empresaId = usuario.empresa_id ?? null;
	const rol       = usuario.rol        ?? null;

	if (!empresaId) {
		// Usuario sin empresa → flujo de registro
		logger.warn('Sin empresa — redirigiendo a registro.');
		_redirect('/registro.html');
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
// Columna MCP: usuarios.terminos_aceptado_en (timestamptz)
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
// SW update cada 60 min + controllerchange con flag anti-loop
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
					showToast('Nueva versión disponible. Recargá para actualizar.', 'info', 8000);
				}
			});
		});

		// Anti-loop: solo recargar una vez por ciclo de vida
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
		logger.warn('PowerSync ya conectando — ignorando llamada duplicada.');
		return;
	}

	if (_powerSyncRetryHandle) {
		clearTimeout(_powerSyncRetryHandle);
		_powerSyncRetryHandle = null;
	}

	_powerSyncRunning = true;

	try {
		await initPowerSync();
		_setState({ powersync: true });
		logger.info('PowerSync conectado.');

	} catch (error) {
		logger.warn(`PowerSync intento ${intentoActual + 1} falló:`, error.message);
		_setState({ powersync: false });
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

		logger.info(`Reintentando PowerSync en ${espera / 1000}s...`);

		_powerSyncRetryHandle = setTimeout(() => {
			_powerSyncRunning = false;
			_paso7_powerSync(sigIntento);
		}, espera);

	} finally {
		if (!_powerSyncRetryHandle) _powerSyncRunning = false;
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 8 — Cola de subida (con verificación de red real)
// ─────────────────────────────────────────────────────────────

async function _paso8_colaSubida() {
	const hayRed = await _hayConexionReal();
	if (!hayRed) return;

	try {
		const pendientes = await colaSubida.pendientes();
		if (pendientes > 0) {
			colaSubida.procesar().catch((e) =>
				logger.warn('Error al procesar cola en init:', e.message)
			);
		}
	} catch (error) {
		logger.warn('Error al verificar cola de subida:', error.message);
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 9 — Renderizar UI según rol
// ─────────────────────────────────────────────────────────────

function _paso9_renderUI() {
	const { rol, usuario } = _appState;

	_renderNav(rol);
	_renderHeader(usuario);
	_marcarNavActiva();

	// Columna MCP: usuarios.es_nuevo_ingresante (bool)
	if (usuario.es_nuevo_ingresante) _mostrarBadgeNuevoIngresante();

	_iniciarSyncBadgeUpdater();
}

// ─────────────────────────────────────────────────────────────
// RENDER: NAV
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// RENDER: HEADER
// ─────────────────────────────────────────────────────────────

function _renderHeader(usuario) {
	const nombreEl = document.getElementById('header-usuario-nombre');
	if (nombreEl && usuario?.nombre_completo) {
		nombreEl.textContent = usuario.nombre_completo;
	}
	renderSyncBadge();
}

// ─────────────────────────────────────────────────────────────
// BADGE NUEVO INGRESANTE
// ─────────────────────────────────────────────────────────────

function _mostrarBadgeNuevoIngresante() {
	const badge = document.getElementById('badge-nuevo-ingresante');
	if (!badge) return;
	badge.textContent   = 'Nuevo ingresante';
	badge.className     = 'badge badge--warning';
	badge.style.display = 'inline-flex';
}

// ─────────────────────────────────────────────────────────────
// SYNC BADGE UPDATER
// interval + evento syncStatus:change + listeners removibles
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
	wrapper.className    = 'empty-state';
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
	btn.className = 'btn btn--primary btn--full';
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
 * Retorna copia profunda del estado — sin mutaciones accidentales.
 * Fallback para WebViews Android antiguos sin structuredClone.
 *
 * @returns {object}
 */
export function getAppState() {
	return typeof structuredClone === 'function'
		? structuredClone(_appState)
		: JSON.parse(JSON.stringify(_appState));
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
 * Llamar al desmontar pantallas en implementaciones SPA.
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
 * Llamar en logout manual o cleanup total.
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
// FIN DE atshel-app.js v3.0.0
// ─────────────────────────────────────────────────────────────
