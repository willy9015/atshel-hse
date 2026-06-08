'use strict';

/**
 * atshel-core.js
 * Utilidades base de ATSHEL: fechas, sanitización, UI, validaciones HSE.
 * Cargado antes que todos los demás módulos.
 * Regla crítica: NUNCA new Date("YYYY-MM-DD") — siempre parseLocalDate().
 */

// ════════════════════════════════════════════════════════════
// 1. FECHAS — SIN BUG UTC
// ════════════════════════════════════════════════════════════

/**
 * Parsea "YYYY-MM-DD" como fecha local (sin conversión UTC).
 * SIEMPRE usar esta función en lugar de new Date("YYYY-MM-DD").
 * @param {string} str — formato "YYYY-MM-DD"
 * @returns {Date}
 */
window.parseLocalDate = function(str) {
	if (!str) return null;
	const [y, m, d] = str.split('-').map(Number);
	return new Date(y, m - 1, d);
};

/**
 * Formatea un Date o string ISO a "DD/MM/YYYY" (Argentina).
 * @param {Date|string} dateOrStr
 * @returns {string}
 */
window.formatDate = function(dateOrStr) {
	if (!dateOrStr) return '—';
	const d = typeof dateOrStr === 'string'
		? new Date(dateOrStr)   // ISO con Z — safe
		: dateOrStr;
	if (isNaN(d.getTime())) return '—';
	return d.toLocaleDateString('es-AR', {
		day:   '2-digit',
		month: '2-digit',
		year:  'numeric',
	});
};

/**
 * Formatea un Date o string ISO a "DD/MM/YYYY HH:MM".
 * @param {Date|string} dateOrStr
 * @returns {string}
 */
window.formatDateTime = function(dateOrStr) {
	if (!dateOrStr) return '—';
	const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
	if (isNaN(d.getTime())) return '—';
	return d.toLocaleString('es-AR', {
		day:    '2-digit',
		month:  '2-digit',
		year:   'numeric',
		hour:   '2-digit',
		minute: '2-digit',
	});
};

/**
 * Devuelve "hace X minutos / horas / días" para listas.
 * @param {string} isoStr
 * @returns {string}
 */
window.timeAgo = function(isoStr) {
	if (!isoStr) return '';
	const now  = Date.now();
	const then = new Date(isoStr).getTime();
	const diff = Math.floor((now - then) / 1000); // segundos

	if (diff < 60)              return 'hace un momento';
	if (diff < 3600)            return `hace ${Math.floor(diff / 60)} min`;
	if (diff < 86400)           return `hace ${Math.floor(diff / 3600)} h`;
	if (diff < 86400 * 7)       return `hace ${Math.floor(diff / 86400)} días`;
	return formatDate(isoStr);
};

/**
 * Genera un ID local único (UUID v4 simplificado).
 * Se usa como atshel_local_id antes de sincronizar.
 * @returns {string}
 */
window.generateLocalId = function() {
	if (crypto && crypto.randomUUID) return crypto.randomUUID();
	// Fallback para Safari < 15.4
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
};

// ════════════════════════════════════════════════════════════
// 2. SANITIZACIÓN (requiere DOMPurify cargado antes)
// ════════════════════════════════════════════════════════════

/**
 * Sanitiza HTML para evitar XSS. SIEMPRE usar antes de innerHTML.
 * @param {string} html
 * @returns {string}
 */
window.safeHTML = function(html) {
	if (typeof DOMPurify === 'undefined') {
		// Fallback de emergencia: solo texto plano
		const div = document.createElement('div');
		div.textContent = html;
		return div.innerHTML;
	}
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS:  ['b', 'i', 'em', 'strong', 'br', 'span'],
		ALLOWED_ATTR:  ['class'],
	});
};

/**
 * Escapa texto para mostrar en DOM como texto puro.
 * @param {string} str
 * @returns {string}
 */
window.escapeText = function(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
};

// ════════════════════════════════════════════════════════════
// 3. TOASTS
// ════════════════════════════════════════════════════════════

(function initToasts() {
	let container = document.getElementById('toast-container');
	if (!container) {
		container = document.createElement('div');
		container.id = 'toast-container';
		container.setAttribute('aria-live', 'polite');
		container.setAttribute('aria-atomic', 'true');
		document.body.appendChild(container);
	}

	/**
	 * Muestra un toast.
	 * @param {string} message
	 * @param {'success'|'error'|'warning'|'info'} type
	 * @param {number} duration ms (0 = permanente)
	 */
	window.showToast = function(message, type = 'info', duration = 4000) {
		const icons = {
			success: '✓',
			error:   '✕',
			warning: '⚠',
			info:    'ℹ',
		};

		const toast = document.createElement('div');
		toast.className = `toast toast-${type}`;
		toast.setAttribute('role', 'alert');
		toast.innerHTML = `
			<span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
			<span>${escapeText(message)}</span>
		`;

		container.appendChild(toast);

		// Vibración háptica en móvil (si disponible)
		if (navigator.vibrate && type === 'error') {
			navigator.vibrate([40, 20, 40]);
		}

		if (duration > 0) {
			setTimeout(() => {
				toast.classList.add('toast-out');
				toast.addEventListener('animationend', () => toast.remove(), { once: true });
			}, duration);
		}

		return toast;
	};
})();

// ════════════════════════════════════════════════════════════
// 4. SPINNER / LOADING OVERLAY
// ════════════════════════════════════════════════════════════

(function initSpinner() {
	let overlay  = null;
	let count    = 0;

	window.showSpinner = function(text = 'Cargando...') {
		count++;
		if (overlay) {
			const p = overlay.querySelector('p');
			if (p) p.textContent = text;
			return;
		}
		overlay = document.createElement('div');
		overlay.className = 'loading-overlay';
		overlay.setAttribute('aria-busy', 'true');
		overlay.setAttribute('aria-label', text);
		overlay.innerHTML = `
			<div class="spinner spinner-lg" role="presentation"></div>
			<p>${escapeText(text)}</p>
		`;
		document.body.appendChild(overlay);
	};

	window.hideSpinner = function() {
		count = Math.max(0, count - 1);
		if (count === 0 && overlay) {
			overlay.remove();
			overlay = null;
		}
	};
})();

// ════════════════════════════════════════════════════════════
// 5. INDICADOR DE SINCRONIZACIÓN
// ════════════════════════════════════════════════════════════

(function initSyncIndicator() {
	let indicator = document.getElementById('sync-indicator');
	if (!indicator) {
		indicator = document.createElement('div');
		indicator.id = 'sync-indicator';
		indicator.setAttribute('aria-live', 'polite');
		document.body.prepend(indicator);
	}

	let hideTimer = null;

	/**
	 * @param {'online'|'offline'|'syncing'|'error'} state
	 * @param {string=} label
	 */
	window.setSyncState = function(state, label) {
		clearTimeout(hideTimer);

		const labels = {
			online:  '● Sincronizado',
			offline: '○ Sin conexión',
			syncing: '↻ Sincronizando...',
			error:   '✕ Error de sync',
		};

		const cssClass = {
			online:  'ok',
			offline: 'offline',
			syncing: 'syncing',
			error:   'error',
		};

		indicator.className = `visible ${cssClass[state] || 'offline'}`;
		indicator.textContent = label || labels[state] || state;

		// Ocultar automáticamente si está online (solo info)
		if (state === 'online') {
			hideTimer = setTimeout(() => {
				indicator.className = '';
			}, 2500);
		}
	};
})();

// ════════════════════════════════════════════════════════════
// 6. VALIDACIONES HSE — LÍMITES NORMATIVOS (SRT 905/2015)
// ════════════════════════════════════════════════════════════

window.HSE = {
	limits: {
		O2:     { min: 19.5, max: 23.5, warnMin: 19.5, warnMax: 23.0 },
		H2S:    { danger: 10, warn: 5 },
		CO:     { danger: 25, warn: 15 },
		LEL:    { danger: 0 },          // cualquier valor >0 es bloqueo
		arnes:  { warnYears: 4.5, dangerYears: 5 },
		viento: { izajeKmh: 30, rafagaKmh: 40 },
		angulo: { minGrados: 30 },
	},

	/**
	 * Valida atmósfera de gases.
	 * @returns {{ ok: boolean, errores: string[], advertencias: string[] }}
	 */
	validarGases(o2, h2s, co, lel) {
		const errores = [];
		const advertencias = [];
		const L = this.limits;

		if (o2 !== null && o2 !== undefined) {
			if (o2 < L.O2.min) errores.push(`O₂ DEFICIENTE: ${o2}% — No ingresar. (mín: ${L.O2.min}%)`);
			else if (o2 > L.O2.max) errores.push(`O₂ ELEVADO: ${o2}% — Riesgo de combustión. (máx: ${L.O2.max}%)`);
		}

		if (h2s !== null && h2s !== undefined) {
			if (h2s >= L.H2S.danger) errores.push(`H₂S PELIGROSO: ${h2s} ppm — Evacuar área.`);
			else if (h2s >= L.H2S.warn) advertencias.push(`H₂S elevado: ${h2s} ppm — Monitoreo continuo.`);
		}

		if (co !== null && co !== undefined) {
			if (co >= L.CO.danger) errores.push(`CO PELIGROSO: ${co} ppm — Ventilar área.`);
			else if (co >= L.CO.warn) advertencias.push(`CO elevado: ${co} ppm — Reducir exposición.`);
		}

		if (lel !== null && lel !== undefined) {
			if (lel > L.LEL.danger) errores.push(`GAS INFLAMABLE DETECTADO: LEL ${lel}% — No encender equipos.`);
		}

		return { ok: errores.length === 0, errores, advertencias };
	},

	/**
	 * Valida vida útil de arnés.
	 * @param {Date|string} fechaFabricacion
	 * @returns {{ ok: boolean, error?: string, advertencia?: string, anios: number }}
	 */
	validarArnes(fechaFabricacion) {
		if (!fechaFabricacion) return { ok: true, anios: 0 };
		const fab  = typeof fechaFabricacion === 'string'
			? parseLocalDate(fechaFabricacion.substring(0, 10))
			: fechaFabricacion;
		const anios = (Date.now() - fab.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
		const L     = this.limits.arnes;

		if (anios > L.dangerYears) return {
			ok: false,
			error: `ARNÉS VENCIDO: ${anios.toFixed(1)} años. Reemplazo obligatorio. (máx: ${L.dangerYears} años)`,
			anios,
		};
		if (anios > L.warnYears) return {
			ok: true,
			advertencia: `Arnés próximo a vencer: ${anios.toFixed(1)} años. Programar reemplazo.`,
			anios,
		};
		return { ok: true, anios };
	},

	/**
	 * Valida condiciones de viento para izaje.
	 * @returns {{ puedeIzar: boolean, puedeSoldar: boolean, mensaje?: string }}
	 */
	validarViento(velocidadKmh, rafagaKmh) {
		const L = this.limits.viento;
		const puedeIzar   = velocidadKmh <= L.izajeKmh && rafagaKmh <= L.rafagaKmh;
		const puedeSoldar = rafagaKmh <= L.rafagaKmh;

		let mensaje = null;
		if (!puedeIzar) {
			mensaje = `Izaje BLOQUEADO: viento ${velocidadKmh} km/h / ráfaga ${rafagaKmh} km/h. ` +
				`(máx izaje: ${L.izajeKmh} km/h / ráfaga: ${L.rafagaKmh} km/h)`;
		} else if (!puedeSoldar) {
			mensaje = `Soldadura BLOQUEADA: ráfaga ${rafagaKmh} km/h. (máx: ${L.rafagaKmh} km/h)`;
		}

		return { puedeIzar, puedeSoldar, mensaje };
	},
};

// ════════════════════════════════════════════════════════════
// 7. NAVEGACIÓN
// ════════════════════════════════════════════════════════════

/**
 * Marca el item activo en la nav inferior según la URL actual.
 */
window.updateNavActive = function() {
	const path = location.pathname;
	document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
		const page = item.dataset.page;
		const isActive = path.includes(page);
		item.classList.toggle('active', isActive);
		item.setAttribute('aria-current', isActive ? 'page' : 'false');
	});
};

// ════════════════════════════════════════════════════════════
// 8. MANEJO DE ERRORES GLOBAL
// ════════════════════════════════════════════════════════════

window.addEventListener('unhandledrejection', (e) => {
	console.error('[ATSHEL] Promise rechazada:', e.reason);
	const msg = e.reason?.message || 'Error inesperado. Intentá de nuevo.';
	// No mostrar errores internos de PowerSync al usuario
	if (msg.includes('PowerSync') || msg.includes('SQLite')) return;
	showToast(msg, 'error');
});

// ════════════════════════════════════════════════════════════
// 9. HEARTBEAT (para detectar borrado de IDB en iOS)
// ════════════════════════════════════════════════════════════

(function initHeartbeat() {
	const TS = 'atshel_heartbeat_ts';

	function saveHeartbeat() {
		const ts = Date.now().toString();
		try {
			localStorage.setItem(TS, ts);
		} catch { /* storage lleno */ }
	}

	// Chequeo al arrancar
	const lastTs = localStorage.getItem(TS);
	if (!lastTs && location.pathname !== '/login.html' && location.pathname !== '/') {
		console.warn('[ATSHEL] Heartbeat no encontrado — posible borrado de IDB en iOS.');
		// Se mostrará modal de recuperación desde atshel-app.js
	}

	saveHeartbeat();
	setInterval(saveHeartbeat, 30_000); // cada 30s
})();

console.info('[ATSHEL] Core cargado ✓');
