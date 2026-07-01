/**
 * atshel-app.js
 * Punto de entrada de ATSHEL. 9 pasos de inicialización en orden.
 * Schema y columnas verificados con MCP Supabase (2026-06-14).
 *
 * Dependencias (deben cargarse antes en el HTML):
 *   /vendor/dompurify.min.js
 *   /vendor/phosphor-icons.min.js
 *   /vendor/jspdf.min.js
 *
 * Importaciones:
 *   atshel-core.js       → utilidades, syncStatus, heartbeat, validaciones
 *   atshel-supabase.js   → auth, RPC, términos
 *   atshel-media.js      → colaSubida
 *   atshel-powersync.js  → initPowerSync, db
 *
 * USO:
 *   Cada HTML de la app incluye este archivo como módulo:
 *   <script type="module" src="/js/atshel-app.js"></script>
 *
 *   Opcionalmente, el HTML puede definir antes de cargar el módulo:
 *   window.ATSHEL_PAGE = 'incidentes'; // para lógica específica de pantalla
 */

import {
	syncStatus,
	showToast,
	showSpinner,
	hideSpinner,
	initHeartbeat,
	checkHeartbeat,
	renderSyncBadge,
} from './atshel-core.js';

import {
	getSession,
	getUsuario,
	getEmpresaId,
	getRol,
	logout,
	terminos,
	requireAuth,
} from './atshel-supabase.js';

import { colaSubida } from './atshel-media.js';

import {
	initPowerSync,
	isPowerSyncReady,
} from './atshel-powersync.js';

// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────

/** Rutas que NO requieren sesión activa */
const RUTAS_PUBLICAS = [
	'/login.html',
	'/offline.html',
];

/** Mapa de roles a menú de navegación visible
 *  Roles verificados MCP: 'administrador' | 'supervisor' | 'hse'
 *  'tecnico' NO EXISTE en el schema real.
 */
const NAV_POR_ROL = {
	hse: [
		{ id: 'nav-inicio',      href: '/index.html',           icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes',  href: '/incidentes.html',      icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-ats',         href: '/ats-nuevo.html',       icono: 'clipboard-text', label: 'ATS'        },
		{ id: 'nav-permisos',    href: '/permisos.html',        icono: 'key',            label: 'Permisos'   },
		{ id: 'nav-perfil',      href: '/perfil.html',          icono: 'user-circle',    label: 'Perfil'     },
	],
	supervisor: [
		{ id: 'nav-inicio',      href: '/index.html',           icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes',  href: '/incidentes.html',      icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-ats',         href: '/ats-supervisor.html',  icono: 'clipboard-text', label: 'ATS'        },
		{ id: 'nav-acciones',    href: '/acciones.html',        icono: 'check-circle',   label: 'Acciones'   },
		{ id: 'nav-perfil',      href: '/perfil.html',          icono: 'user-circle',    label: 'Perfil'     },
	],
	administrador: [
		{ id: 'nav-inicio',      href: '/index.html',           icono: 'house',          label: 'Inicio'     },
		{ id: 'nav-incidentes',  href: '/incidentes.html',      icono: 'warning-circle', label: 'Incidentes' },
		{ id: 'nav-dashboard',   href: '/dashboard.html',       icono: 'chart-bar',      label: 'Dashboard'  },
		{ id: 'nav-equipos',     href: '/equipos.html',         icono: 'wrench',         label: 'Equipos'    },
		{ id: 'nav-perfil',      href: '/perfil.html',          icono: 'user-circle',    label: 'Perfil'     },
	],
};

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL DE LA APP
// ─────────────────────────────────────────────────────────────

export const AppState = {
	session:    null,   // Sesión de Supabase
	usuario:    null,   // Fila de public.usuarios
	empresaId:  null,   // UUID de empresa (del JWT)
	rol:        null,   // 'administrador' | 'supervisor' | 'hse'
	powersync:  false,  // true cuando PowerSync está listo
	paginaActual: window.ATSHEL_PAGE ?? _detectarPagina(),
};

function _detectarPagina() {
	const path = window.location.pathname;
	const nombre = path.split('/').pop()?.replace('.html', '') || 'index';
	return nombre;
}

// ─────────────────────────────────────────────────────────────
// PUNTO DE ENTRADA PRINCIPAL
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
	const rutaActual = window.location.pathname;
	const esPublica  = RUTAS_PUBLICAS.some((r) => rutaActual.endsWith(r));

	if (esPublica) {
		// Pantallas públicas: solo inicializar lo mínimo
		await _initPublico();
		return;
	}

	// Pantallas protegidas: los 9 pasos
	await _initProtegido();
});

// ─────────────────────────────────────────────────────────────
// INICIALIZACIÓN PÚBLICA (login, offline)
// ─────────────────────────────────────────────────────────────

async function _initPublico() {
	// Si ya hay sesión activa y estamos en login → redirigir a index
	if (window.location.pathname.endsWith('login.html')) {
		const session = await getSession();
		if (session) {
			window.location.replace('/index.html');
		}
	}
}

// ─────────────────────────────────────────────────────────────
// INICIALIZACIÓN PROTEGIDA — 9 PASOS
// ─────────────────────────────────────────────────────────────

async function _initProtegido() {
	try {

		// ── PASO 1: Verificar sesión activa ─────────────────────
		await _paso1_verificarSesion();

		// ── PASO 2: Cargar datos del usuario y empresa ───────────
		await _paso2_cargarUsuario();

		// ── PASO 3: Verificar términos aceptados ─────────────────
		await _paso3_verificarTerminos();

		// ── PASO 4: Verificar PIN configurado ────────────────────
		await _paso4_verificarPin();

		// ── PASO 5: Iniciar heartbeat dual ───────────────────────
		await _paso5_heartbeat();

		// ── PASO 6: Registrar Service Worker ─────────────────────
		await _paso6_serviceWorker();

		// ── PASO 7: Inicializar PowerSync ────────────────────────
		await _paso7_powerSync();

		// ── PASO 8: Procesar cola de subida pendiente ────────────
		await _paso8_colaSubida();

		// ── PASO 9: Renderizar UI según rol ──────────────────────
		_paso9_renderUI();

		// Listo — disparar evento para que el HTML de cada pantalla
		// pueda suscribirse y cargar sus propios datos
		document.dispatchEvent(new CustomEvent('atshel:ready', {
			detail: { ...AppState },
		}));

	} catch (error) {
		// Errores de sesión ya manejan redirección internamente
		// Otros errores: mostrar estado de error en UI
		if (!error.message?.includes('ERR_SYS_11')) {
			console.error('[ATSHEL] Error en inicialización:', error);
			_mostrarErrorInicializacion(error.message);
		}
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 1 — Verificar sesión
// ─────────────────────────────────────────────────────────────

async function _paso1_verificarSesion() {
	const session = await getSession();

	if (!session) {
		// Sin sesión → login
		window.location.replace('/login.html');
		throw new Error('ERR_SYS_11: Sin sesión activa.');
	}

	AppState.session = session;
}

// ─────────────────────────────────────────────────────────────
// PASO 2 — Cargar usuario y empresa
// ─────────────────────────────────────────────────────────────

async function _paso2_cargarUsuario() {
	const [usuario, empresaId, rol] = await Promise.all([
		getUsuario(),
		getEmpresaId(),
		getRol(),
	]);

	if (!usuario || !empresaId || !rol) {
		// El usuario existe en Auth pero no en public.usuarios
		// Esto no debería pasar — indica un problema de onboarding
		console.error('[ATSHEL] ERR_SYS_23: Usuario en Auth sin fila en public.usuarios.');
		showToast('Error al cargar tu perfil. Contactá al administrador.', 'error', 6000);
		await logout();
		throw new Error('ERR_SYS_23: Perfil incompleto.');
	}

	// Verificar que la cuenta esté activa
	// Columna verificada MCP: usuarios.activo (bool)
	if (!usuario.activo) {
		showToast('Tu cuenta está desactivada. Contactá al administrador.', 'error', 6000);
		await logout();
		throw new Error('ERR_SYS_24: Cuenta desactivada.');
	}

	AppState.usuario   = usuario;
	AppState.empresaId = empresaId;
	AppState.rol       = rol;
}

// ─────────────────────────────────────────────────────────────
// PASO 3 — Verificar términos aceptados
//   Columna verificada MCP: usuarios.terminos_aceptado_en (timestamptz)
// ─────────────────────────────────────────────────────────────

async function _paso3_verificarTerminos() {
	const { terminos_aceptado_en } = AppState.usuario;

	if (!terminos_aceptado_en) {
		// No aceptó términos → setup.html (paso términos)
		window.location.replace('/setup.html?paso=terminos');
		throw new Error('ERR_SYS_25: Términos no aceptados.');
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 4 — Verificar PIN configurado
//   No se puede consultar usuarios_credenciales directamente desde el cliente
//   (REVOKE ejecutado — solo service_role puede leerla).
//   La verificación se hace intentando crear un nonce:
//   si el PIN no existe, fn_crear_nonce() retorna error específico.
// ─────────────────────────────────────────────────────────────

async function _paso4_verificarPin() {
	// Solo verificar en setup.html si se llega aquí desde un redirect
	// En pantallas normales, el PIN se verifica al momento de firmar
	// No bloqueamos el flujo si el PIN no está configurado aquí —
	// se redirige a setup al intentar firmar.
	// Este paso es solo para setup.html
	if (window.location.pathname.endsWith('setup.html')) return;

	// Verificación diferida: se maneja en cada flujo de firma
}

// ─────────────────────────────────────────────────────────────
// PASO 5 — Heartbeat dual (localStorage + IndexedDB)
//   Detecta si iOS borró IDB y muestra modal de recuperación.
// ─────────────────────────────────────────────────────────────

async function _paso5_heartbeat() {
	// Verificar estado del heartbeat anterior
	const { perdido, ultimoLS } = await checkHeartbeat();

	if (perdido && ultimoLS) {
		// iOS borró IndexedDB — mostrar aviso
		_mostrarModalIDBPerdido(new Date(ultimoLS));
	}

	// Iniciar nuevo heartbeat
	await initHeartbeat();
}

function _mostrarModalIDBPerdido(ultimaActividad) {
	const modal = document.createElement('div');
	modal.setAttribute('role', 'alertdialog');
	modal.setAttribute('aria-modal', 'true');
	modal.setAttribute('aria-labelledby', 'modal-idb-titulo');

	Object.assign(modal.style, {
		position:        'fixed',
		inset:           '0',
		background:      'rgba(0,0,0,0.7)',
		display:         'flex',
		alignItems:      'center',
		justifyContent:  'center',
		zIndex:          '9999',
		padding:         '24px',
	});

	const fecha = ultimaActividad
		? ultimaActividad.toLocaleString('es-AR')
		: 'desconocida';

	modal.innerHTML = `
		<div style="
			background: #1F252D;
			border: 1px solid rgba(249,115,22,0.3);
			border-radius: 12px;
			padding: 24px;
			max-width: 360px;
			width: 100%;
		">
			<p id="modal-idb-titulo" style="
				font-size: 17px;
				font-weight: 700;
				color: #F97316;
				margin-bottom: 12px;
			">⚠ Datos locales eliminados</p>
			<p style="font-size: 15px; color: #8B98A8; line-height: 1.5; margin-bottom: 20px;">
				El sistema operativo liberó espacio y eliminó los datos locales.
				Tu última actividad registrada fue el <strong style="color: #F0F4F8">${fecha}</strong>.
				Los datos ya sincronizados están seguros en el servidor.
			</p>
			<button id="btn-modal-idb-ok" style="
				width: 100%;
				height: 52px;
				background: #FFC107;
				color: #0A0C0E;
				border: none;
				border-radius: 8px;
				font-size: 16px;
				font-weight: 700;
				cursor: pointer;
			">Entendido</button>
		</div>
	`;

	document.body.appendChild(modal);

	// Event listener en init — no en render
	document.getElementById('btn-modal-idb-ok')?.addEventListener('click', () => {
		modal.remove();
	}, { once: true });
}

// ─────────────────────────────────────────────────────────────
// PASO 6 — Registrar Service Worker
// ─────────────────────────────────────────────────────────────

async function _paso6_serviceWorker() {
	if (!('serviceWorker' in navigator)) {
		console.warn('[ATSHEL] Service Worker no disponible en este navegador.');
		return;
	}

	try {
		const registro = await navigator.serviceWorker.register('/sw.js', {
			scope: '/',
			updateViaCache: 'none',   // Siempre verificar actualizaciones
		});

		// Notificar al usuario cuando hay una nueva versión disponible
		registro.addEventListener('updatefound', () => {
			const nuevoSW = registro.installing;
			nuevoSW?.addEventListener('statechange', () => {
				if (nuevoSW.state === 'installed' && navigator.serviceWorker.controller) {
					showToast('Nueva versión disponible. Recargá la página para actualizar.', 'info', 8000);
				}
			});
		});

	} catch (error) {
		// No es crítico — la app funciona sin SW, solo sin caché offline
		console.warn('[ATSHEL] Error al registrar Service Worker:', error.message);
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 7 — Inicializar PowerSync
// ─────────────────────────────────────────────────────────────

async function _paso7_powerSync() {
	try {
		await initPowerSync();
		AppState.powersync = true;

	} catch (error) {
		// PowerSync es deseable pero no bloquea la app
		// En modo degradado, las queries van directo a Supabase
		console.warn('[ATSHEL] PowerSync no disponible:', error.message);
		AppState.powersync = false;
		syncStatus.actualizar({ estado: 'desconectado' });

		showToast(
			'Modo sin sincronización automática. Los datos se guardan cuando haya señal.',
			'warning',
			5000
		);
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 8 — Procesar cola de subida pendiente
// ─────────────────────────────────────────────────────────────

async function _paso8_colaSubida() {
	if (!navigator.onLine) return;

	try {
		const pendientes = await colaSubida.pendientes();
		if (pendientes > 0) {
			// Procesar en background — no bloquear la UI
			colaSubida.procesar().catch((e) => {
				console.warn('[ATSHEL] Error al procesar cola en init:', e.message);
			});
		}
	} catch (error) {
		console.warn('[ATSHEL] Error al verificar cola de subida:', error.message);
	}
}

// ─────────────────────────────────────────────────────────────
// PASO 9 — Renderizar UI según rol
// ─────────────────────────────────────────────────────────────

function _paso9_renderUI() {
	const { rol, usuario } = AppState;

	// Renderizar navegación inferior según rol
	_renderNav(rol);

	// Actualizar header con nombre y sync badge
	_renderHeader(usuario);

	// Marcar ítem activo en la nav
	_marcarNavActiva();

	// Mostrar badge de nuevo ingresante
	// Columna verificada MCP: usuarios.es_nuevo_ingresante (bool)
	if (usuario.es_nuevo_ingresante) {
		_mostrarBadgeNuevoIngresante();
	}

	// Iniciar actualización periódica del badge de sync
	_iniciarSyncBadgeUpdater();
}

// ─────────────────────────────────────────────────────────────
// RENDER: NAVEGACIÓN INFERIOR
// ─────────────────────────────────────────────────────────────

function _renderNav(rol) {
	const nav = document.querySelector('.app-nav');
	if (!nav) return;

	const items = NAV_POR_ROL[rol] ?? NAV_POR_ROL.hse;

	nav.innerHTML = items.map((item) => `
		<a
			id="${item.id}"
			href="${item.href}"
			class="nav-item"
			aria-label="${item.label}"
		>
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
	// Nombre del usuario en header
	const nombreEl = document.getElementById('header-usuario-nombre');
	if (nombreEl && usuario?.nombre_completo) {
		nombreEl.textContent = usuario.nombre_completo;
	}

	// Badge de sync inicial
	renderSyncBadge();
}

// ─────────────────────────────────────────────────────────────
// BADGE DE NUEVO INGRESANTE
//   Visible durante los primeros 4 meses (verificado por es_nuevo_ingresante)
//   Columnas MCP: es_nuevo_ingresante (bool), fecha_ingreso (date)
// ─────────────────────────────────────────────────────────────

function _mostrarBadgeNuevoIngresante() {
	const badge = document.getElementById('badge-nuevo-ingresante');
	if (!badge) return;

	badge.textContent   = 'Nuevo ingresante';
	badge.className     = 'badge badge--warning';
	badge.style.display = 'inline-flex';
}

// ─────────────────────────────────────────────────────────────
// UPDATER DEL BADGE DE SYNC
// ─────────────────────────────────────────────────────────────

function _iniciarSyncBadgeUpdater() {
	// Actualizar inmediatamente
	renderSyncBadge();

	// Actualizar cada 10 segundos
	setInterval(renderSyncBadge, 10_000);

	// También actualizar en eventos de red
	window.addEventListener('online',  () => renderSyncBadge());
	window.addEventListener('offline', () => {
		syncStatus.actualizar({ estado: 'desconectado' });
		renderSyncBadge();
	});
}

// ─────────────────────────────────────────────────────────────
// MANEJO DE ERRORES DE INICIALIZACIÓN
// ─────────────────────────────────────────────────────────────

function _mostrarErrorInicializacion(mensaje) {
	const contenido = document.querySelector('.app-content');
	if (!contenido) return;

	contenido.innerHTML = `
		<div class="empty-state" style="padding-top: 80px;">
			<div class="empty-state__icon">⚠</div>
			<p class="empty-state__title">Error al iniciar</p>
			<p class="empty-state__desc">${mensaje ?? 'Ocurrió un error inesperado.'}</p>
			<button
				class="btn btn--primary btn--full"
				style="margin-top: 24px; max-width: 280px;"
				onclick="window.location.reload()"
			>
				Reintentar
			</button>
		</div>
	`;
}

// ─────────────────────────────────────────────────────────────
// API PÚBLICA — helpers para HTMLs de cada pantalla
// ─────────────────────────────────────────────────────────────

/**
 * Espera a que la app esté lista y ejecuta el callback.
 * Usar en cada HTML de pantalla en lugar de DOMContentLoaded directo.
 *
 * @param {function(typeof AppState): void} callback
 *
 * Ejemplo de uso en incidentes.html:
 *   <script type="module">
 *     import { onReady } from '/js/atshel-app.js';
 *     onReady(async (state) => {
 *       const lista = await cargarIncidentes(state.empresaId);
 *       renderLista(lista);
 *     });
 *   </script>
 */
export function onReady(callback) {
	document.addEventListener('atshel:ready', (e) => {
		callback(e.detail);
	}, { once: true });
}

/**
 * Retorna el estado actual de la app.
 * Disponible después de que 'atshel:ready' se disparó.
 * @returns {typeof AppState}
 */
export function getAppState() {
	return { ...AppState };
}

/**
 * Verifica que el rol del usuario tiene acceso a una sección.
 * Si no tiene acceso, muestra toast y redirige a index.
 *
 * @param {...string} rolesPermitidos — Roles válidos: 'administrador' | 'supervisor' | 'hse'
 * @returns {boolean}
 */
export function verificarAcceso(...rolesPermitidos) {
	const { rol } = AppState;

	if (!rolesPermitidos.includes(rol)) {
		showToast('No tenés acceso a esta sección.', 'error');
		setTimeout(() => { window.location.replace('/index.html'); }, 1500);
		return false;
	}

	return true;
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-app.js
// ─────────────────────────────────────────────────────────────
