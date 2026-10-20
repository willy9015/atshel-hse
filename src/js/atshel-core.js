/**
 * atshel-core.js
 * Utilidades base de ATSHEL. Sin dependencias de otros módulos propios.
 * Requiere: /vendor/dompurify.min.js cargado antes que este archivo.
 *
 * v3.1.0 — Blindaje de Validaciones HSE, Heartbeat Resiliente y SyncStatus Completo
 *
 * Mejoras v3.1.0:
 *   1. validarGases() y validarViento() blindados contra NaN, null, undefined y strings
 *      vacíos. Nunca devuelven `ok: true` ante lecturas ausentes o malformadas.
 *   2. showToast() usa `textContent` directo sin recortar símbolos matemáticos (`<`, `>`)
 *      en alertas de gases (ej. "O₂ < 19.5%").
 *   3. syncStatus incluye el estado `'sincronizando'` y emite `'syncStatus:change'`
 *      automáticamente al actualizarse.
 *   4. Heartbeat IDB reabre la conexión si el navegador cerró el handle en background
 *      (evita falsos positivos del modal de pérdida de datos en iOS/Android).
 *   5. Montaje seguro en DOM (`document.body || document.documentElement`).
 *
 * Exporta:
 *   - LIMITES_SEGURIDAD
 *   - parseLocalDate(str)
 *   - formatFecha(date)
 *   - formatFechaCorta(date)
 *   - sanitizeHTML(str)
 *   - sanitizeHTMLRich(str)
 *   - generateLocalId()
 *   - softDelete()
 *   - showToast(mensaje, tipo, duracion)
 *   - showSpinner() / hideSpinner()
 *   - syncStatus
 *   - renderSyncBadge(status)
 *   - initHeartbeat() / checkHeartbeat() / stopHeartbeat()
 *   - validarGases({ o2, h2s, co, lel })
 *   - validarArnes(fechaFabricacion)
 *   - validarViento({ velocidad, rafaga })
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
 * Convierte "YYYY-MM-DD" a Date local sin desfase UTC.
 * @param {string} str — formato "YYYY-MM-DD"
 * @returns {Date|null}
 */
export function parseLocalDate(str) {
	if (!str || typeof str !== 'string') return null;
	const limpio = str.trim().split('T')[0];
	const partes = limpio.split('-').map(Number);
	if (partes.length !== 3 || partes.some( Number.isNaN )) return null;
	const [y, m, d] = partes;
	const fecha = new Date(y, m - 1, d);
	if (fecha.getFullYear() !== y || fecha.getMonth() !== m - 1 || fecha.getDate() !== d) {
		return null;
	}
	return fecha;
}

/**
 * Formatea una Date a "DD/MM/YYYY HH:mm" en zona local.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatFecha(date) {
	if (!date) return '—';
	const d = date instanceof Date ? date : new Date(date);
	if (Number.isNaN(d.getTime())) return '—';

	const dd   = String(d.getDate()).padStart(2, '0');
	const mm   = String(d.getMonth() + 1).padStart(2, '0');
	const yyyy = d.getFullYear();
	const hh   = String(d.getHours()).padStart(2, '0');
	const min  = String(d.getMinutes()).padStart(2, '0');

	return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

/**
 * Formatea una Date a "DD/MM/YYYY" en zona local.
 * Si recibe "YYYY-MM-DD", usa parseLocalDate para evitar corrimiento de día en UTC-3.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatFechaCorta(date) {
	if (!date) return '—';
	const d = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
		? parseLocalDate(date)
		: (date instanceof Date ? date : new Date(date));

	if (!d || Number.isNaN(d.getTime())) return '—';

	const dd   = String(d.getDate()).padStart(2, '0');
	const mm   = String(d.getMonth() + 1).padStart(2, '0');
	const yyyy = d.getFullYear();

	return `${dd}/${mm}/${yyyy}`;
}

// ─────────────────────────────────────────────────────────────
// 3. SANITIZACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Sanitiza HTML usando DOMPurify (elimina todas las etiquetas).
 * Usar cuando se inserta contenido dinámico en atributos o fragmentos HTML.
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
 * Usar solo para contenido propio de la app (ej. términos y condiciones), nunca para input de usuario.
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
 * Garantiza idempotencia en sincronización offline.
 * @returns {string} UUID v4
 */
export function generateLocalId() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
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
 * Retorna el objeto de UPDATE para soft-delete (`deleted_at`).
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
	if (_toastContainer && document.contains(_toastContainer)) return _toastContainer;

	_toastContainer = document.createElement('div');
	_toastContainer.id = 'atshel-toast-container';
	_toastContainer.setAttribute('role', 'status');
	_toastContainer.setAttribute('aria-live', 'polite');
	_toastContainer.setAttribute('aria-atomic', 'false');

	Object.assign(_toastContainer.style, {
		position:      'fixed',
		bottom:        '80px',
		left:          '50%',
		transform:     'translateX(-50%)',
		zIndex:        '9999',
		display:       'flex',
		flexDirection: 'column',
		alignItems:    'center',
		gap:           '8px',
		pointerEvents: 'none',
		width:         'calc(100% - 32px)',
		maxWidth:      '400px',
	});

	(document.body || document.documentElement).appendChild(_toastContainer);
	return _toastContainer;
}

/**
 * Muestra un mensaje toast seguro usando `textContent` (preserva `<` y `>` en alertas HSE).
 * @param {string} mensaje
 * @param {'success'|'error'|'warning'|'info'} [tipo='info']
 * @param {number} [duracion=3500] — ms
 */
export function showToast(mensaje, tipo = 'info', duracion = 3500) {
	const colores = {
		success: { bg: '#2E7D32', icon: '✓' },
		error:   { bg: '#C62828', icon: '✕' },
		warning: { bg: '#E65100', icon: '⚠' },
		info:    { bg: '#01579B', icon: 'ℹ' },
	};

	const { bg, icon } = colores[tipo] || colores.info;
	const container    = _getToastContainer();

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
		minHeight:     '48px',
	});

	const iconSpan = document.createElement('span');
	iconSpan.textContent = icon;
	iconSpan.setAttribute('aria-hidden', 'true');
	iconSpan.style.flexShrink = '0';
	iconSpan.style.fontSize   = '18px';

	const texto = document.createElement('span');
	texto.textContent = String(mensaje ?? '');

	toast.appendChild(iconSpan);
	toast.appendChild(texto);
	container.appendChild(toast);

	requestAnimationFrame(() => {
		toast.style.opacity = '1';
	});

	setTimeout(() => {
		toast.style.opacity = '0';
		setTimeout(() => {
			toast.remove();
		}, 200);
	}, duracion);
}

// ─────────────────────────────────────────────────────────────
// 7. SPINNER
// ─────────────────────────────────────────────────────────────

let _spinner      = null;
let _spinnerCount = 0;

function _crearSpinner() {
	const overlay = document.createElement('div');
	overlay.id = 'atshel-spinner';
	overlay.setAttribute('role', 'status');
	overlay.setAttribute('aria-label', 'Cargando...');

	Object.assign(overlay.style, {
		position:       'fixed',
		inset:          '0',
		background:     'rgba(0,0,0,0.45)',
		display:        'flex',
		alignItems:     'center',
		justifyContent: 'center',
		zIndex:         '10000',
	});

	const circulo = document.createElement('div');
	Object.assign(circulo.style, {
		width:          '48px',
		height:         '48px',
		border:         '4px solid rgba(255,255,255,0.3)',
		borderTopColor: '#FFC107',
		borderRadius:   '50%',
		animation:      'atshel-spin 0.8s linear infinite',
	});

	if (!document.getElementById('atshel-spin-style')) {
		const style = document.createElement('style');
		style.id = 'atshel-spin-style';
		style.textContent = '@keyframes atshel-spin { to { transform: rotate(360deg); } }';
		document.head.appendChild(style);
	}

	overlay.appendChild(circulo);
	(document.body || document.documentElement).appendChild(overlay);
	return overlay;
}

/** Muestra el spinner global con conteo de llamadas anidadas. */
export function showSpinner() {
	_spinnerCount++;
	if (!_spinner || !document.contains(_spinner)) {
		_spinner = _crearSpinner();
	}
}

/** Oculta el spinner global cuando todas las operaciones activas finalizaron. */
export function hideSpinner() {
	_spinnerCount = Math.max(0, _spinnerCount - 1);
	if (_spinnerCount === 0 && _spinner) {
		_spinner.remove();
		_spinner = null;
	}
}

// ─────────────────────────────────────────────────────────────
// 8. ESTADO DE SINCRONIZACIÓN
// ─────────────────────────────────────────────────────────────

export const syncStatus = {
	estado:     'desconectado', // 'sincronizado' | 'sincronizando' | 'pendiente' | 'desconectado' | 'error'
	ultimaSync: null,
	pendientes: 0,
	_listeners: [],

	/**
	 * Actualiza el estado, notifica a los listeners registrados y emite 'syncStatus:change'.
	 * @param {{ estado?: string, ultimaSync?: Date, pendientes?: number }} datos
	 */
	actualizar(datos = {}) {
		if (datos.estado)                   this.estado     = datos.estado;
		if (datos.ultimaSync !== undefined) this.ultimaSync = datos.ultimaSync;
		if (datos.pendientes !== undefined) this.pendientes = datos.pendientes;

		this._listeners.forEach((fn) => {
			try { fn(this); } catch (e) { console.error('[ATSHEL] Error en listener de sync:', e); }
		});

		if (typeof document !== 'undefined') {
			document.dispatchEvent(new CustomEvent('syncStatus:change', { detail: this }));
		}
	},

	/** Registra una función que se ejecuta cada vez que cambia el estado. */
	onChange(fn) {
		if (typeof fn === 'function' && !this._listeners.includes(fn)) {
			this._listeners.push(fn);
		}
	},

	/** Retorna texto y color para mostrar en UI. */
	get label() {
		const map = {
			sincronizado:  { texto: 'Sincronizado',    color: '#2E7D32' },
			sincronizando: { texto: 'Sincronizando…',  color: '#0288D1' },
			pendiente:     { texto: 'Pendiente',       color: '#F57C00' },
			desconectado:  { texto: 'Sin conexión',    color: '#C62828' },
			error:         { texto: 'Error de sync',   color: '#C62828' },
		};
		return map[this.estado] || map.desconectado;
	},
};

// ─────────────────────────────────────────────────────────────
// 9. HEARTBEAT DUAL (localStorage + IndexedDB)
// ─────────────────────────────────────────────────────────────

const HEARTBEAT_KEY      = 'atshel_heartbeat';
const HEARTBEAT_IDB      = 'atshel_heartbeat_idb';
const HEARTBEAT_INTERVAL = 30_000;

let _heartbeatTimer = null;
let _idb            = null;

async function _openHeartbeatIDB() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('atshel_heartbeat_db', 1);
		req.onupgradeneeded = (e) => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains('meta')) {
				db.createObjectStore('meta');
			}
		};
		req.onsuccess = (e) => {
			const db = e.target.result;
			db.onclose      = () => { _idb = null; };
			db.onversionchange = () => { db.close(); _idb = null; };
			resolve(db);
		};
		req.onerror = () => reject(req.error);
	});
}

async function _writeHeartbeatIDB(ts) {
	for (let intento = 0; intento < 2; intento++) {
		try {
			if (!_idb) _idb = await _openHeartbeatIDB();
			await new Promise((resolve, reject) => {
				const tx = _idb.transaction('meta', 'readwrite');
				tx.objectStore('meta').put(ts, HEARTBEAT_IDB);
				tx.oncomplete = () => resolve();
				tx.onerror    = () => reject(tx.error);
			});
			return;
		} catch (e) {
			_idb = null;
			if (intento === 1) {
				console.warn('[ATSHEL] Heartbeat IDB write failed:', e);
			}
		}
	}
}

async function _readHeartbeatIDB() {
	for (let intento = 0; intento < 2; intento++) {
		try {
			if (!_idb) _idb = await _openHeartbeatIDB();
			return await new Promise((resolve, reject) => {
				const tx  = _idb.transaction('meta', 'readonly');
				const req = tx.objectStore('meta').get(HEARTBEAT_IDB);
				req.onsuccess = () => resolve(req.result || null);
				req.onerror   = () => reject(req.error);
			});
		} catch {
			_idb = null;
		}
	}
	return null;
}

function _writeHeartbeatLS(ts) {
	try {
		localStorage.setItem(HEARTBEAT_KEY, String(ts));
	} catch {}
}

function _readHeartbeatLS() {
	try {
		const v = localStorage.getItem(HEARTBEAT_KEY);
		return v ? Number(v) : null;
	} catch {
		return null;
	}
}

/** Inicia el heartbeat dual. Llamar desde atshel-app.js */
export async function initHeartbeat() {
	if (_heartbeatTimer) return;

	const escribir = async () => {
		const ts = Date.now();
		_writeHeartbeatLS(ts);
		await _writeHeartbeatIDB(ts);
	};

	await escribir();
	_heartbeatTimer = setInterval(escribir, HEARTBEAT_INTERVAL);
}

/** Detiene el timer de heartbeat. */
export function stopHeartbeat() {
	if (_heartbeatTimer) {
		clearInterval(_heartbeatTimer);
		_heartbeatTimer = null;
	}
}

/**
 * Verifica si el sistema operativo borró IndexedDB manteniendo localStorage.
 * @returns {Promise<{ perdido: boolean, ultimoLS: number|null, ultimoIDB: number|null }>}
 */
export async function checkHeartbeat() {
	const ultimoLS  = _readHeartbeatLS();
	const ultimoIDB = await _readHeartbeatIDB();

	const perdido = ultimoLS !== null && ultimoIDB === null;
	return { perdido, ultimoLS, ultimoIDB };
}

// ─────────────────────────────────────────────────────────────
// 10. VALIDACIONES DE SEGURIDAD INDUSTRIAL (BLINDADAS CONTRA NaN/VACÍOS)
// ─────────────────────────────────────────────────────────────

function _aNumeroFinito(val) {
	if (val === null || val === undefined || val === '') return NaN;
	const n = Number(val);
	return Number.isFinite(n) ? n : NaN;
}

/**
 * Valida mediciones de gases contra límites críticos.
 * Si algún valor es inválido o está vacío, bloquea con ERR_HSE_00.
 *
 * @param {{ o2: number|string, h2s: number|string, co: number|string, lel: number|string }} gases
 * @returns {{ ok: boolean, errores: string[], advertencias: string[] }}
 */
export function validarGases(gases = {}) {
	const errores      = [];
	const advertencias = [];
	const L            = LIMITES_SEGURIDAD;

	const nO2  = _aNumeroFinito(gases.o2);
	const nH2S = _aNumeroFinito(gases.h2s);
	const nCO  = _aNumeroFinito(gases.co);
	const nLEL = _aNumeroFinito(gases.lel);

	if (Number.isNaN(nO2) || Number.isNaN(nH2S) || Number.isNaN(nCO) || Number.isNaN(nLEL)) {
		errores.push('ERR_HSE_00: Medición de gases incompleta. Ingresá valores numéricos válidos para O₂, H₂S, CO y LEL.');
		return { ok: false, errores, advertencias };
	}

	if (nO2 < 0 || nH2S < 0 || nCO < 0 || nLEL < 0) {
		errores.push('ERR_HSE_00: Los valores de medición de gases no pueden ser negativos.');
		return { ok: false, errores, advertencias };
	}

	// O₂
	if (nO2 < L.O2_MIN) {
		errores.push(`ERR_HSE_01: ATMÓSFERA DEFICIENTE. O₂ = ${nO2}% (mín. ${L.O2_MIN}%). No ingresar.`);
	} else if (nO2 > L.O2_MAX) {
		errores.push(`ERR_HSE_02: OXÍGENO ELEVADO. O₂ = ${nO2}% (máx. ${L.O2_MAX}%). Riesgo de combustión.`);
	}

	// H₂S
	if (nH2S >= L.H2S_PELIGROSO) {
		errores.push(`ERR_HSE_03: H₂S PELIGROSO. ${nH2S} ppm (límite ${L.H2S_PELIGROSO} ppm). Evacuar área.`);
	} else if (nH2S >= L.H2S_ALERTA) {
		advertencias.push(`WARN_HSE_03: H₂S elevado. ${nH2S} ppm. Monitoreo continuo.`);
	}

	// CO
	if (nCO >= L.CO_PELIGROSO) {
		errores.push(`ERR_HSE_04: CO PELIGROSO. ${nCO} ppm (límite ${L.CO_PELIGROSO} ppm). Ventilar área.`);
	} else if (nCO >= L.CO_ALERTA) {
		advertencias.push(`WARN_HSE_04: CO elevado. ${nCO} ppm. Reducir exposición.`);
	}

	// LEL
	if (nLEL > L.LEL_MAX) {
		errores.push(`ERR_HSE_05: GAS INFLAMABLE DETECTADO. LEL = ${nLEL}%. Evacuación inmediata.`);
	}

	return {
		ok: errores.length === 0,
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

	const fecha = (typeof fechaFabricacion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fechaFabricacion.trim()))
		? parseLocalDate(fechaFabricacion)
		: (fechaFabricacion instanceof Date ? fechaFabricacion : new Date(fechaFabricacion));

	if (!fecha || Number.isNaN(fecha.getTime())) {
		return { ok: false, error: 'ERR_HSE_06: Fecha de fabricación de arnés inválida.', advertencia: null, añosUso: 0 };
	}

	const msAnio  = 1000 * 60 * 60 * 24 * 365.25;
	const añosUso = (Date.now() - fecha.getTime()) / msAnio;

	if (añosUso < 0) {
		return { ok: false, error: 'ERR_HSE_06: La fecha de fabricación del arnés no puede ser futura.', advertencia: null, añosUso: 0 };
	}

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
 * @param {{ velocidad: number|string, rafaga?: number|string }} viento — ambos en km/h
 * @returns {{ okIzaje: boolean, okSoldadura: boolean, errores: string[], advertencias: string[] }}
 */
export function validarViento(viento = {}) {
	const L            = LIMITES_SEGURIDAD;
	const errores      = [];
	const advertencias = [];

	const nVel    = _aNumeroFinito(viento.velocidad);
	const nRafaga = (viento.rafaga === undefined || viento.rafaga === null || viento.rafaga === '')
		? nVel
		: _aNumeroFinito(viento.rafaga);

	if (Number.isNaN(nVel) || Number.isNaN(nRafaga) || nVel < 0 || nRafaga < 0) {
		errores.push('ERR_HSE_07: Ingresá valores numéricos válidos de velocidad y ráfaga de viento (km/h).');
		return { okIzaje: false, okSoldadura: false, errores, advertencias };
	}

	const velMax      = Math.max(nVel, nRafaga);
	const okIzaje     = velMax <= L.VIENTO_IZAJE;
	const okSoldadura = velMax <= L.VIENTO_SOLDADURA;

	if (!okIzaje) {
		errores.push(`ERR_HSE_07: VIENTO PROHÍBE IZAJE. Velocidad/ráfaga ${velMax} km/h (máx. ${L.VIENTO_IZAJE} km/h).`);
	}
	if (!okSoldadura) {
		errores.push(`ERR_HSE_08: VIENTO PROHÍBE SOLDADURA. Velocidad/ráfaga ${velMax} km/h (máx. ${L.VIENTO_SOLDADURA} km/h).`);
	}

	return { okIzaje, okSoldadura, errores, advertencias };
}

// ─────────────────────────────────────────────────────────────
// 11. UTILIDAD: INDICADOR DE SYNC EN DOM
// ─────────────────────────────────────────────────────────────

/**
 * Actualiza el elemento #sync-badge en la pantalla actual.
 * @param {typeof syncStatus} [status=syncStatus]
 */
export function renderSyncBadge(status = syncStatus) {
	const badge = document.getElementById('sync-badge');
	if (!badge) return;

	const { texto, color } = status.label;
	badge.textContent = texto;
	badge.style.color = color;
}

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
// FIN DE atshel-core.js v3.1.0
// ─────────────────────────────────────────────────────────────
