/**
 * atshel-core.js
 * Utilidades base de ATSHEL. Sin dependencias de otros módulos propios.
 * Requiere: /vendor/dompurify.min.js cargado antes que este archivo.
 *
 * Exporta:
 *   - LIMITES_SEGURIDAD
 *   - parseLocalDate(str)
 *   - formatFecha(date)
 *   - formatFechaCorta(date)
 *   - sanitizeHTML(str)
 *   - generateLocalId()
 *   - showToast(mensaje, tipo)
 *   - showSpinner() / hideSpinner()
 *   - validarGases({ o2, h2s, co, lel })
 *   - validarArnes(fechaFabricacion)
 *   - validarViento({ velocidad, rafaga })
 *   - softDelete(obj)
 *   - syncStatus
 *   - initHeartbeat()
 *   - checkHeartbeat()
 */

// ─────────────────────────────────────────────────────────────
// 1. LÍMITES CRÍTICOS DE SEGURIDAD INDUSTRIAL
//    Fuente: CLAUDE.md auditado 2026-06-14
//    No modificar sin actualizar también las funciones RPC del backend.
// ─────────────────────────────────────────────────────────────

export const LIMITES_SEGURIDAD = Object.freeze({
	// Oxígeno (%)
	O2_MIN:             19.5,
	O2_MAX:             23.5,

	// Gases tóxicos (ppm)
	H2S_PELIGROSO:      10,
	H2S_ALERTA:         5,
	CO_PELIGROSO:       25,
	CO_ALERTA:          15,

	// Inflamabilidad (% LEL)
	LEL_MAX:            0,

	// Arnés (años)
	ARNES_VIDA_UTIL:    5,
	ARNES_ALERTA:       4.5,

	// Viento (km/h)
	VIENTO_IZAJE:       30,
	VIENTO_SOLDADURA:   40,

	// Izaje (grados)
	ANGULO_IZAJE_MIN:   30,

	// Excavación
	TALUD_MIN_GRADOS:   45,     // grados (para profundidad > 1.5m)
	TALUD_PROF_CRITICA: 1.5,    // metros
	BORDE_MIN:          2,      // metros mínimos entre material y borde
});

// ─────────────────────────────────────────────────────────────
// 2. FECHAS
//    NUNCA usar new Date("YYYY-MM-DD") — bug UTC cambia el día en Argentina (UTC-3)
// ─────────────────────────────────────────────────────────────

/**
 * Convierte "YYYY-MM-DD" a Date local sin bug UTC.
 * @param {string} str — formato "YYYY-MM-DD"
 * @returns {Date}
 */
export function parseLocalDate(str) {
	if (!str || typeof str !== 'string') return null;
	const partes = str.split('-').map(Number);
	if (partes.length !== 3 || partes.some(isNaN)) return null;
	const [y, m, d] = partes;
	return new Date(y, m - 1, d);
}

/**
 * Formatea una Date a "DD/MM/YYYY HH:mm" en zona local.
 * @param {Date|string} date
 * @returns {string}
 */
export function formatFecha(date) {
	if (!date) return '—';
	const d = date instanceof Date ? date : new Date(date);
	if (isNaN(d.getTime())) return '—';

	const dd  = String(d.getDate()).padStart(2, '0');
	const mm  = String(d.getMonth() + 1).padStart(2, '0');
	const yyyy = d.getFullYear();
	const hh  = String(d.getHours()).padStart(2, '0');
	const min = String(d.getMinutes()).padStart(2, '0');

	return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

/**
 * Formatea una Date a "DD/MM/YYYY" en zona local.
 * @param {Date|string} date
 * @returns {string}
 */
export function formatFechaCorta(date) {
	if (!date) return '—';
	const d = date instanceof Date ? date : new Date(date);
	if (isNaN(d.getTime())) return '—';

	const dd  = String(d.getDate()).padStart(2, '0');
	const mm  = String(d.getMonth() + 1).padStart(2, '0');
	const yyyy = d.getFullYear();

	return `${dd}/${mm}/${yyyy}`;
}

// ─────────────────────────────────────────────────────────────
// 3. SANITIZACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Sanitiza HTML usando DOMPurify.
 * Si DOMPurify no está cargado, retorna string vacío y loguea error.
 * @param {string} str
 * @returns {string}
 */
export function sanitizeHTML(str) {
	if (typeof str !== 'string') return '';
	if (typeof DOMPurify === 'undefined') {
		console.error('[ATSHEL] DOMPurify no está cargado. Cargá /vendor/dompurify.min.js antes que atshel-core.js');
		return '';
	}
	return DOMPurify.sanitize(str, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Sanitiza HTML permitiendo formato básico (b, i, br, p, ul, li).
 * Usar solo para contenido propio de la app, nunca para input de usuario.
 * @param {string} str
 * @returns {string}
 */
export function sanitizeHTMLRich(str) {
	if (typeof str !== 'string') return '';
	if (typeof DOMPurify === 'undefined') {
		console.error('[ATSHEL] DOMPurify no está cargado.');
		return '';
	}
	return DOMPurify.sanitize(str, {
		ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'li', 'span'],
		ALLOWED_ATTR: ['class'],
	});
}

// ─────────────────────────────────────────────────────────────
// 4. IDs LOCALES
// ─────────────────────────────────────────────────────────────

/**
 * Genera un UUID v4 para atshel_local_id.
 * Garantiza idempotencia: si el mismo registro se intenta insertar dos veces,
 * el trigger del backend rechaza el duplicado con error IDEMPOTENT:id.
 * @returns {string} UUID v4
 */
export function generateLocalId() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	// Fallback para entornos sin crypto.randomUUID
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// ─────────────────────────────────────────────────────────────
// 5. SOFT DELETE
// ─────────────────────────────────────────────────────────────

/**
 * Retorna el objeto de UPDATE para soft-delete.
 * La columna is_deleted NO existe en el schema real.
 * El soft-delete usa deleted_at (verificado con MCP 2026-06-14).
 * @returns {{ deleted_at: string }}
 */
export function softDelete() {
	return { deleted_at: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────
// 6. TOASTS
// ─────────────────────────────────────────────────────────────

let _toastContainer = null;

function _getToastContainer() {
	if (_toastContainer) return _toastContainer;

	_toastContainer = document.createElement('div');
	_toastContainer.id = 'atshel-toast-container';
	_toastContainer.setAttribute('role', 'status');
	_toastContainer.setAttribute('aria-live', 'polite');
	_toastContainer.setAttribute('aria-atomic', 'false');

	Object.assign(_toastContainer.style, {
		position:       'fixed',
		bottom:         '80px',    // por encima de la nav inferior (56px + margen)
		left:           '50%',
		transform:      'translateX(-50%)',
		zIndex:         '9999',
		display:        'flex',
		flexDirection:  'column',
		alignItems:     'center',
		gap:            '8px',
		pointerEvents:  'none',
		width:          'calc(100% - 32px)',
		maxWidth:       '400px',
	});

	document.body.appendChild(_toastContainer);
	return _toastContainer;
}

/**
 * Muestra un mensaje toast.
 * @param {string} mensaje
 * @param {'success'|'error'|'warning'|'info'} tipo
 * @param {number} duracion — ms, default 3500
 */
export function showToast(mensaje, tipo = 'info', duracion = 3500) {
	const colores = {
		success: { bg: '#2E7D32', icon: '✓' },
		error:   { bg: '#C62828', icon: '✕' },
		warning: { bg: '#E65100', icon: '⚠' },
		info:    { bg: '#01579B', icon: 'ℹ' },
	};

	const { bg, icon } = colores[tipo] || colores.info;
	const container = _getToastContainer();

	const toast = document.createElement('div');
	toast.setAttribute('role', 'alert');

	Object.assign(toast.style, {
		background:    bg,
		color:         '#FFFFFF',
		padding:       '12px 16px',
		borderRadius:  '8px',
		fontSize:      '15px',
		fontWeight:    '500',
		lineHeight:    '1.4',
		display:       'flex',
		alignItems:    'flex-start',
		gap:           '8px',
		width:         '100%',
		boxShadow:     '0 4px 12px rgba(0,0,0,0.3)',
		pointerEvents: 'auto',
		opacity:       '0',
		transition:    'opacity 200ms ease',
		minHeight:     '48px',   // target táctil mínimo
	});

	const iconSpan = document.createElement('span');
	iconSpan.textContent = icon;
	iconSpan.setAttribute('aria-hidden', 'true');
	iconSpan.style.flexShrink = '0';
	iconSpan.style.fontSize = '18px';

	const texto = document.createElement('span');
	// sanitizeHTML aquí porque el mensaje puede venir de error.message del backend
	texto.textContent = sanitizeHTML(mensaje) || mensaje;

	toast.appendChild(iconSpan);
	toast.appendChild(texto);
	container.appendChild(toast);

	// Animar entrada
	requestAnimationFrame(() => {
		toast.style.opacity = '1';
	});

	// Animar salida y remover
	setTimeout(() => {
		toast.style.opacity = '0';
		setTimeout(() => {
			if (toast.parentNode) toast.parentNode.removeChild(toast);
		}, 200);
	}, duracion);
}

// ─────────────────────────────────────────────────────────────
// 7. SPINNER
// ─────────────────────────────────────────────────────────────

let _spinner = null;
let _spinnerCount = 0;

function _crearSpinner() {
	const overlay = document.createElement('div');
	overlay.id = 'atshel-spinner';
	overlay.setAttribute('role', 'status');
	overlay.setAttribute('aria-label', 'Cargando...');

	Object.assign(overlay.style, {
		position:        'fixed',
		inset:           '0',
		background:      'rgba(0,0,0,0.45)',
		display:         'flex',
		alignItems:      'center',
		justifyContent:  'center',
		zIndex:          '10000',
	});

	const circulo = document.createElement('div');
	Object.assign(circulo.style, {
		width:           '48px',
		height:          '48px',
		border:          '4px solid rgba(255,255,255,0.3)',
		borderTopColor:  '#FFC107',   // --color-accent
		borderRadius:    '50%',
		animation:       'atshel-spin 0.8s linear infinite',
	});

	// Inyectar keyframes una sola vez
	if (!document.getElementById('atshel-spin-style')) {
		const style = document.createElement('style');
		style.id = 'atshel-spin-style';
		style.textContent = '@keyframes atshel-spin { to { transform: rotate(360deg); } }';
		document.head.appendChild(style);
	}

	overlay.appendChild(circulo);
	document.body.appendChild(overlay);
	return overlay;
}

/** Muestra el spinner global. Llamadas anidadas se cuentan — se oculta solo cuando todas terminan. */
export function showSpinner() {
	_spinnerCount++;
	if (!_spinner) {
		_spinner = _crearSpinner();
	}
}

/** Oculta el spinner global. */
export function hideSpinner() {
	_spinnerCount = Math.max(0, _spinnerCount - 1);
	if (_spinnerCount === 0 && _spinner) {
		_spinner.parentNode?.removeChild(_spinner);
		_spinner = null;
	}
}

// ─────────────────────────────────────────────────────────────
// 8. ESTADO DE SINCRONIZACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * syncStatus — objeto reactivo con el estado de sincronización PowerSync.
 * Se actualiza desde atshel-powersync.js.
 * Las pantallas lo leen para mostrar el indicador de sync.
 */
export const syncStatus = {
	estado: 'desconectado',  // 'sincronizado' | 'pendiente' | 'desconectado' | 'error'
	ultimaSync: null,         // Date
	pendientes: 0,            // cantidad de operaciones pendientes
	_listeners: [],

	/**
	 * Actualiza el estado y notifica a todos los listeners.
	 * @param {{ estado, ultimaSync?, pendientes? }} datos
	 */
	actualizar(datos) {
		if (datos.estado)      this.estado = datos.estado;
		if (datos.ultimaSync)  this.ultimaSync = datos.ultimaSync;
		if (datos.pendientes !== undefined) this.pendientes = datos.pendientes;

		this._listeners.forEach((fn) => {
			try { fn(this); } catch (e) { console.error('[ATSHEL] Error en listener de sync:', e); }
		});
	},

	/** Registra una función que se ejecuta cada vez que cambia el estado. */
	onChange(fn) {
		if (typeof fn === 'function') this._listeners.push(fn);
	},

	/** Retorna texto y color para mostrar en UI. */
	get label() {
		const map = {
			sincronizado:  { texto: 'Sincronizado',  color: '#2E7D32' },
			pendiente:     { texto: 'Pendiente',      color: '#F57C00' },
			desconectado:  { texto: 'Sin conexión',   color: '#C62828' },
			error:         { texto: 'Error de sync',  color: '#C62828' },
		};
		return map[this.estado] || map.desconectado;
	},
};

// ─────────────────────────────────────────────────────────────
// 9. HEARTBEAT DUAL (localStorage + IndexedDB)
//    iOS Safari puede borrar IndexedDB sin aviso en condiciones de poca memoria.
//    El heartbeat detecta esta situación y muestra modal de recuperación.
// ─────────────────────────────────────────────────────────────

const HEARTBEAT_KEY = 'atshel_heartbeat';
const HEARTBEAT_IDB = 'atshel_heartbeat_idb';
const HEARTBEAT_INTERVAL = 30_000; // 30 segundos
let _heartbeatTimer = null;
let _idb = null;

async function _openHeartbeatIDB() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('atshel_heartbeat_db', 1);
		req.onupgradeneeded = (e) => {
			e.target.result.createObjectStore('meta');
		};
		req.onsuccess = (e) => resolve(e.target.result);
		req.onerror   = () => reject(req.error);
	});
}

async function _writeHeartbeatIDB(ts) {
	try {
		if (!_idb) _idb = await _openHeartbeatIDB();
		const tx  = _idb.transaction('meta', 'readwrite');
		const s   = tx.objectStore('meta');
		s.put(ts, HEARTBEAT_IDB);
	} catch (e) {
		// IDB no disponible — iOS pudo haberla borrado
		console.warn('[ATSHEL] Heartbeat IDB write failed:', e);
	}
}

async function _readHeartbeatIDB() {
	try {
		if (!_idb) _idb = await _openHeartbeatIDB();
		return new Promise((resolve) => {
			const tx  = _idb.transaction('meta', 'readonly');
			const req = tx.objectStore('meta').get(HEARTBEAT_IDB);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror   = () => resolve(null);
		});
	} catch {
		return null;
	}
}

function _writeHeartbeatLS(ts) {
	try {
		localStorage.setItem(HEARTBEAT_KEY, String(ts));
	} catch {
		// localStorage no disponible en modo privado
	}
}

function _readHeartbeatLS() {
	try {
		const v = localStorage.getItem(HEARTBEAT_KEY);
		return v ? Number(v) : null;
	} catch {
		return null;
	}
}

/** Inicia el heartbeat dual. Llamar una sola vez desde atshel-app.js */
export async function initHeartbeat() {
	if (_heartbeatTimer) return; // ya iniciado

	const escribir = async () => {
		const ts = Date.now();
		_writeHeartbeatLS(ts);
		await _writeHeartbeatIDB(ts);
	};

	await escribir();
	_heartbeatTimer = setInterval(escribir, HEARTBEAT_INTERVAL);
}

/**
 * Verifica si iOS borró IndexedDB.
 * @returns {{ perdido: boolean, ultimoLS: number|null, ultimoIDB: number|null }}
 */
export async function checkHeartbeat() {
	const ultimoLS  = _readHeartbeatLS();
	const ultimoIDB = await _readHeartbeatIDB();

	// Si localStorage tiene timestamp pero IDB no, iOS borró IDB
	const perdido = ultimoLS !== null && ultimoIDB === null;

	return { perdido, ultimoLS, ultimoIDB };
}

// ─────────────────────────────────────────────────────────────
// 10. VALIDACIONES DE SEGURIDAD INDUSTRIAL
// ─────────────────────────────────────────────────────────────

/**
 * Valida mediciones de gases contra límites críticos.
 * Refleja exactamente la lógica de fn_validar_gases() en el backend.
 *
 * @param {{ o2: number, h2s: number, co: number, lel: number }} gases
 * @returns {{ ok: boolean, errores: string[], advertencias: string[] }}
 */
export function validarGases({ o2, h2s, co, lel }) {
	const errores     = [];
	const advertencias = [];
	const L = LIMITES_SEGURIDAD;

	// O₂
	if (o2 < L.O2_MIN) {
		errores.push(`ERR_HSE_01: ATMÓSFERA DEFICIENTE. O₂ = ${o2}% (mín. ${L.O2_MIN}%). No ingresar.`);
	} else if (o2 > L.O2_MAX) {
		errores.push(`ERR_HSE_02: OXÍGENO ELEVADO. O₂ = ${o2}% (máx. ${L.O2_MAX}%). Riesgo de combustión.`);
	}

	// H₂S
	if (h2s >= L.H2S_PELIGROSO) {
		errores.push(`ERR_HSE_03: H₂S PELIGROSO. ${h2s} ppm (límite ${L.H2S_PELIGROSO} ppm). Evacuar área.`);
	} else if (h2s >= L.H2S_ALERTA) {
		advertencias.push(`WARN_HSE_03: H₂S elevado. ${h2s} ppm. Monitoreo continuo.`);
	}

	// CO
	if (co >= L.CO_PELIGROSO) {
		errores.push(`ERR_HSE_04: CO PELIGROSO. ${co} ppm (límite ${L.CO_PELIGROSO} ppm). Ventilar área.`);
	} else if (co >= L.CO_ALERTA) {
		advertencias.push(`WARN_HSE_04: CO elevado. ${co} ppm. Reducir exposición.`);
	}

	// LEL
	if (lel > L.LEL_MAX) {
		errores.push(`ERR_HSE_05: GAS INFLAMABLE DETECTADO. LEL = ${lel}%. Evacuación inmediata.`);
	}

	return {
		ok:          errores.length === 0,
		errores,
		advertencias,
	};
}

/**
 * Valida la vida útil de un arnés.
 * @param {Date|string} fechaFabricacion
 * @returns {{ ok: boolean, error: string|null, advertencia: string|null, añosUso: number }}
 */
export function validarArnes(fechaFabricacion) {
	const L = LIMITES_SEGURIDAD;

	const fecha = fechaFabricacion instanceof Date
		? fechaFabricacion
		: new Date(fechaFabricacion);

	if (isNaN(fecha.getTime())) {
		return { ok: false, error: 'ERR_HSE_06: Fecha de fabricación de arnés inválida.', advertencia: null, añosUso: 0 };
	}

	const msAnio  = 1000 * 60 * 60 * 24 * 365.25;
	const añosUso = (Date.now() - fecha.getTime()) / msAnio;

	if (añosUso > L.ARNES_VIDA_UTIL) {
		return {
			ok:          false,
			error:       `ERR_HSE_06: ARNÉS VENCIDO. ${añosUso.toFixed(1)} años de uso (máx. ${L.ARNES_VIDA_UTIL}). Reemplazo obligatorio.`,
			advertencia: null,
			añosUso,
		};
	}

	if (añosUso > L.ARNES_ALERTA) {
		return {
			ok:          true,
			error:       null,
			advertencia: `WARN_HSE_06: Arnés próximo a vencer. ${añosUso.toFixed(1)} años de uso.`,
			añosUso,
		};
	}

	return { ok: true, error: null, advertencia: null, añosUso };
}

/**
 * Valida condiciones de viento para izaje y soldadura.
 * @param {{ velocidad: number, rafaga: number }} viento — ambos en km/h
 * @returns {{ okIzaje: boolean, okSoldadura: boolean, errores: string[], advertencias: string[] }}
 */
export function validarViento({ velocidad, rafaga }) {
	const L = LIMITES_SEGURIDAD;
	const errores     = [];
	const advertencias = [];

	const velMax  = Math.max(velocidad, rafaga);

	const okIzaje     = velMax <= L.VIENTO_IZAJE;
	const okSoldadura = velMax <= L.VIENTO_SOLDADURA;

	if (!okIzaje) {
		errores.push(`ERR_HSE_07: VIENTO PROHIBE IZAJE. Velocidad ${velMax} km/h (máx. ${L.VIENTO_IZAJE} km/h).`);
	}
	if (!okSoldadura) {
		errores.push(`ERR_HSE_08: VIENTO PROHIBE SOLDADURA. Ráfaga ${rafaga} km/h (máx. ${L.VIENTO_SOLDADURA} km/h).`);
	}

	return { okIzaje, okSoldadura, errores, advertencias };
}

// ─────────────────────────────────────────────────────────────
// 11. UTILIDAD: INDICADOR DE SYNC EN DOM
//    Llamar desde cada pantalla para actualizar el badge de estado.
// ─────────────────────────────────────────────────────────────

/**
 * Actualiza el elemento #sync-badge en la pantalla actual.
 * El HTML de cada pantalla debe tener: <span id="sync-badge"></span>
 * @param {{ estado: string, label: { texto: string, color: string } }} status
 */
export function renderSyncBadge(status = syncStatus) {
	const badge = document.getElementById('sync-badge');
	if (!badge) return;

	const { texto, color } = status.label;
	badge.textContent = texto;
	badge.style.color = color;
}

// Actualizar badge automáticamente cuando cambia el estado
syncStatus.onChange(renderSyncBadge);

// ─────────────────────────────────────────────────────────────
// 12. GUARD DE CARGA: verificar que DOMPurify está disponible
// ─────────────────────────────────────────────────────────────

if (typeof DOMPurify === 'undefined') {
	console.error(
		'[ATSHEL] atshel-core.js cargado sin DOMPurify. ' +
		'Asegurate de cargar /vendor/dompurify.min.js ANTES que este módulo.'
	);
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-core.js
// ─────────────────────────────────────────────────────────────
