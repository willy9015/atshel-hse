/**
 * atshel-supabase.js
 * Cliente Supabase para ATSHEL HSE Manager.
 * Argumentos RPC verificados contra schema real (MCP 2026-10).
 *
 * v3.2.0 — Firma Atómica de ATS (H-01, H-06, H-07) + Blindaje Offline MPA
 *
 * Cambios v3.2.0:
 *   1. firmarAts({ instanciaId, pin, localId }) — nueva función que ejecuta el flujo
 *      transaccional atómico fn_firmar_ats(p_instancia_id, p_nonce, p_pin, p_atshel_local_id):
 *        - Solicita un nonce fresco de un solo uso con crearNonce(session.user.id).
 *        - Envía la firma con clave de idempotencia (p_atshel_local_id) para resistir microcortes.
 *        - Procesa respuestas JSON de negocio (ERR_PIN_03 con intentos_restantes, ERR_PIN_02, etc.).
 *   2. ATSHELError — clase de error unificada con código estandarizado.
 *   3. Caché de usuario en RAM + localStorage aislado por user.id (`atshel_usuario_cache_<uuid>`).
 *   4. _withRetry() — reintentos automáticos con corte instantáneo (0ms) si navigator.onLine === false.
 *   5. logout() — soporta cierre de sesión sin señal ({ scope: 'local' }).
 *
 * Exporta:
 *   supabase, ATSHELError,
 *   getSession(), getUsuario(), getEmpresaId(), getRol(),
 *   invalidarCacheUsuario(),
 *   login(), logout(), recuperarPassword(),
 *   crearNonce(), verificarPin(), establecerPin(), firmarAts(),
 *   verificarSesion(), calcularKpis(),
 *   terminos.{ obtenerVigente, aceptar, usuarioAcepto },
 *   registrarEmpresa(),
 *   requireAuth(), requireRole(),
 *   handleSupabaseError()
 */

import { createClient } from '@supabase/supabase-js';
import {
	showToast,
	showSpinner,
	hideSpinner,
} from './atshel-core.js';

// ─────────────────────────────────────────────────────────────
// 0. LOGGER INTERNO
//    info → solo DEV | warn/error → siempre
// ─────────────────────────────────────────────────────────────

const _log = {
	info:  import.meta.env.DEV ? (...a) => console.info('[ATSHEL:supabase]', ...a)  : () => {},
	warn:  (...a) => console.warn('[ATSHEL:supabase]', ...a),
	error: (...a) => console.error('[ATSHEL:supabase]', ...a),
};

// ─────────────────────────────────────────────────────────────
// 1. CLASE DE ERROR UNIFICADA
// ─────────────────────────────────────────────────────────────

/**
 * Error estándar de ATSHEL con código y contexto.
 */
export class ATSHELError extends Error {
	/**
	 * @param {string} codigo — Código de error (ej: 'ERR_SYS_03')
	 * @param {string} mensaje — Mensaje legible para el usuario
	 * @param {Object} [contexto] — Datos adicionales para debugging
	 */
	constructor(codigo, mensaje, contexto = {}) {
		super(`${codigo}: ${mensaje}`);
		this.name     = 'ATSHELError';
		this.codigo   = codigo;
		this.mensaje  = mensaje;
		this.contexto = contexto;
	}

	toJSON() {
		return {
			name:     this.name,
			codigo:   this.codigo,
			mensaje:  this.mensaje,
			contexto: this.contexto,
		};
	}
}

// ─────────────────────────────────────────────────────────────
// 2. INICIALIZACIÓN DEL CLIENTE
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON) {
	throw new ATSHELError(
		'ERR_SYS_01',
		'Variables de entorno faltantes. Definí VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env.local'
	);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
	auth: {
		persistSession:     true,
		storageKey:         'atshel_session',
		autoRefreshToken:   true,
		detectSessionInUrl: false,
	},
	global: {
		headers: {
			'X-Client-Info': 'atshel-hse/3.2',
		},
	},
});

// ─────────────────────────────────────────────────────────────
// 3. CACHÉ DE SESIÓN Y USUARIO (RAM + LOCALSTORAGE AISLADO POR USER_ID)
// ─────────────────────────────────────────────────────────────

const USUARIO_CACHE_TTL    = 5 * 60 * 1_000;
const USUARIO_STORAGE_PREF = 'atshel_usuario_cache_';

let _sessionCache   = null;
let _usuarioCache   = null;
let _usuarioCacheTs = 0;

function _guardarUsuarioStorage(userId, data) {
	if (!userId || !data) return;
	try {
		localStorage.setItem(
			`${USUARIO_STORAGE_PREF}${userId}`,
			JSON.stringify({ data, ts: Date.now() })
		);
	} catch (e) {
		_log.warn('No se pudo persistir caché de usuario en localStorage:', e);
	}
}

function _leerUsuarioStorage(userId) {
	if (!userId) return null;
	try {
		const raw = localStorage.getItem(`${USUARIO_STORAGE_PREF}${userId}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed?.data?.id !== userId) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Invalida el caché del usuario en RAM y elimina los perfiles persistidos en localStorage.
 */
export function invalidarCacheUsuario() {
	_usuarioCache   = null;
	_usuarioCacheTs = 0;
	try {
		for (let i = localStorage.length - 1; i >= 0; i--) {
			const k = localStorage.key(i);
			if (k && k.startsWith(USUARIO_STORAGE_PREF)) {
				localStorage.removeItem(k);
			}
		}
	} catch (e) {
		_log.warn('Error limpiando localStorage de usuario:', e);
	}
}

supabase.auth.onAuthStateChange((event, session) => {
	if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session) {
		const prevUserId = _sessionCache?.user?.id;
		_sessionCache = session;

		if (prevUserId && prevUserId !== session.user.id) {
			invalidarCacheUsuario();
		} else {
			_usuarioCache   = null;
			_usuarioCacheTs = 0;
		}
		_log.info(`Evento Auth [${event}]. Caché de sesión actualizado.`);
	}

	if (event === 'SIGNED_OUT') {
		_sessionCache = null;
		invalidarCacheUsuario();
		navigator.serviceWorker?.controller?.postMessage({ tipo: 'CLEAR_MEDIA_CACHE' });
		_log.info('Sesión cerrada. Caché de usuario y media limpiados.');
	}
});

// ─────────────────────────────────────────────────────────────
// 4. HELPER: RETRY CON BACKOFF EXPONENCIAL (CORTE RÁPIDO OFFLINE)
// ─────────────────────────────────────────────────────────────

const RETRY_DELAYS = [500, 1_500, 3_000];

async function _withRetry(fn, maxIntentos = 3) {
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		throw new Error('Failed to fetch (dispositivo offline)');
	}

	let ultimoError;

	for (let i = 0; i < maxIntentos; i++) {
		try {
			return await fn();
		} catch (error) {
			ultimoError = error;

			const esErrorDeRed =
				error.message?.includes('fetch') ||
				error.message?.includes('network') ||
				error.message?.includes('Failed to fetch') ||
				error.message?.includes('NetworkError');

			if (!esErrorDeRed || (typeof navigator !== 'undefined' && !navigator.onLine)) {
				throw error;
			}

			if (i < maxIntentos - 1) {
				const espera = RETRY_DELAYS[i] ?? RETRY_DELAYS.at(-1);
				_log.warn(`Intento ${i + 1} fallido. Reintentando en ${espera}ms...`);
				await new Promise((r) => setTimeout(r, espera));
			}
		}
	}

	throw ultimoError;
}

// ─────────────────────────────────────────────────────────────
// 5. SESIÓN Y PERFIL (OFFLINE-RESILIENT)
// ─────────────────────────────────────────────────────────────

export async function getSession() {
	if (_sessionCache) return _sessionCache;

	const { data, error } = await supabase.auth.getSession();
	if (error || !data?.session) return null;

	_sessionCache = data.session;
	return _sessionCache;
}

export async function getUsuario() {
	const session = await getSession();
	if (!session?.user?.id) return null;

	const userId = session.user.id;
	const ahora  = Date.now();

	if (_usuarioCache && _usuarioCache.id === userId && (ahora - _usuarioCacheTs) < USUARIO_CACHE_TTL) {
		return _usuarioCache;
	}

	const persistido = _leerUsuarioStorage(userId);

	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		if (persistido?.data) {
			_usuarioCache   = persistido.data;
			_usuarioCacheTs = persistido.ts;
			return _usuarioCache;
		}
		return null;
	}

	if (persistido?.data && (ahora - persistido.ts) < USUARIO_CACHE_TTL) {
		_usuarioCache   = persistido.data;
		_usuarioCacheTs = persistido.ts;
		return _usuarioCache;
	}

	try {
		const { data, error } = await _withRetry(() =>
			supabase
				.from('usuarios')
				.select(`
					id,
					empresa_id,
					rol,
					nombre_completo,
					oficio,
					tipo_trabajo_id,
					es_nuevo_ingresante,
					fecha_ingreso,
					induccion_completada,
					terminos_aceptado_en,
					activo,
					tutor_id
				`)
				.eq('id', userId)
				.is('deleted_at', null)
				.maybeSingle()
		);

		if (error) {
			_log.error('Error al cargar usuario:', error.message);
			return persistido?.data ?? null;
		}

		_usuarioCache   = data;
		_usuarioCacheTs = Date.now();
		if (data) _guardarUsuarioStorage(userId, data);
		return _usuarioCache;

	} catch (error) {
		_log.error('Error de red al cargar usuario (usando respaldo offline):', error.message);
		return persistido?.data ?? _usuarioCache ?? null;
	}
}

export async function getEmpresaId() {
	const session = await getSession();
	if (!session) return null;

	const fromJwt = session.user?.app_metadata?.empresa_id ?? null;
	if (fromJwt) return fromJwt;

	const usuario = await getUsuario();
	return usuario?.empresa_id ?? null;
}

export async function getRol() {
	const session = await getSession();
	if (!session) return null;

	const fromJwt = session.user?.app_metadata?.rol ?? null;
	if (fromJwt) return fromJwt;

	const usuario = await getUsuario();
	return usuario?.rol ?? null;
}

// ─────────────────────────────────────────────────────────────
// 6. AUTENTICACIÓN
// ─────────────────────────────────────────────────────────────

export async function login(email, password) {
	showSpinner();
	try {
		invalidarCacheUsuario();

		const { data, error } = await supabase.auth.signInWithPassword({
			email:    email.trim().toLowerCase(),
			password,
		});

		if (error) return { ok: false, error: _traducirErrorAuth(error.message) };
		if (!data.session) return { ok: false, error: 'ERR_SYS_02: No se pudo iniciar sesión. Intentá de nuevo.' };

		_sessionCache = data.session;
		return { ok: true, error: null };

	} catch (e) {
		_log.error('Error inesperado en login:', e);
		return { ok: false, error: 'ERR_SYS_03: Error de conexión. Verificá tu señal.' };
	} finally {
		hideSpinner();
	}
}

export async function logout() {
	showSpinner();
	try {
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			await supabase.auth.signOut({ scope: 'local' });
		} else {
			await supabase.auth.signOut();
		}
	} catch (e) {
		_log.error('Error en logout remoto, forzando cierre local:', e);
		await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
	} finally {
		_sessionCache = null;
		invalidarCacheUsuario();
		try {
			localStorage.removeItem('atshel_session');
		} catch {}
		navigator.serviceWorker?.controller?.postMessage({ tipo: 'CLEAR_MEDIA_CACHE' });
		hideSpinner();
	}
}

export async function recuperarPassword(email) {
	showSpinner();
	try {
		const { error } = await supabase.auth.resetPasswordForEmail(
			email.trim().toLowerCase(),
			{ redirectTo: `${window.location.origin}/login.html` }
		);

		if (error) return { ok: false, error: _traducirErrorAuth(error.message) };
		return { ok: true, error: null };

	} catch (e) {
		return { ok: false, error: 'ERR_SYS_04: Error de conexión al enviar el email.' };
	} finally {
		hideSpinner();
	}
}

function _traducirErrorAuth(msg) {
	const map = {
		'Invalid login credentials':   'Email o contraseña incorrectos.',
		'Email not confirmed':          'Confirmá tu email antes de ingresar.',
		'User not found':               'No existe una cuenta con ese email.',
		'Password should be at least':  'La contraseña debe tener al menos 6 caracteres.',
		'Too many requests':            'Demasiados intentos. Esperá unos minutos.',
		'User is banned':               'Tu cuenta está suspendida. Contactá al administrador.',
		'Network request failed':       'Sin conexión. Verificá tu señal.',
	};

	for (const [key, value] of Object.entries(map)) {
		if (msg.includes(key)) return value;
	}

	return `ERR_SYS_05: ${msg}`;
}

// ─────────────────────────────────────────────────────────────
// 7. VALIDACIÓN DE PIN — CENTRALIZADA
// ─────────────────────────────────────────────────────────────

function _validarPin(pin) {
	if (!pin || typeof pin !== 'string') {
		return { valido: false, error: 'ERR_HSE_11: PIN requerido.' };
	}
	if (pin.length < 4 || pin.length > 6) {
		return { valido: false, error: 'ERR_HSE_11: El PIN debe tener entre 4 y 6 dígitos.' };
	}
	if (!/^\d+$/.test(pin)) {
		return { valido: false, error: 'ERR_HSE_12: El PIN solo puede contener números.' };
	}
	return { valido: true, error: null };
}

// ─────────────────────────────────────────────────────────────
// 8. PIN Y FIRMA ATÓMICA DE ATS — RPC VERIFICADOS CON MCP
//
//    fn_crear_nonce(p_usuario_id uuid) → uuid
//    fn_verificar_pin(p_usuario_id uuid, p_pin text) → boolean
//    fn_establecer_pin(p_usuario_id uuid, p_pin text) → void
//    fn_firmar_ats(p_instancia_id uuid, p_nonce uuid, p_pin text, p_atshel_local_id text) → jsonb
// ─────────────────────────────────────────────────────────────

/**
 * Solicita un nonce de firma de un solo uso (expira en 5 minutos).
 *
 * @param {string} usuarioId — UUID del usuario autenticado
 * @returns {Promise<{ ok: boolean, nonceId: string|null, error: string|null }>}
 */
export async function crearNonce(usuarioId) {
	if (!usuarioId) {
		return { ok: false, nonceId: null, error: 'ERR_SYS_06: usuarioId requerido para crear nonce.' };
	}

	try {
		const { data, error } = await _withRetry(() =>
			supabase.rpc('fn_crear_nonce', { p_usuario_id: usuarioId })
		);

		if (error) {
			_log.error('Error al crear nonce:', error.message);
			return { ok: false, nonceId: null, error: 'ERR_HSE_10: No se pudo generar el código de firma.' };
		}

		return { ok: true, nonceId: data, error: null };

	} catch (e) {
		return { ok: false, nonceId: null, error: 'ERR_SYS_03: Sin conexión para crear código de firma.' };
	}
}

/**
 * Verifica el PIN del usuario de forma independiente (cuando no es firma de ATS).
 *
 * @param {string} usuarioId — UUID del usuario
 * @param {string} pin — PIN en texto plano (4-6 dígitos numéricos)
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function verificarPin(usuarioId, pin) {
	if (!usuarioId) return { ok: false, error: 'ERR_SYS_07: usuarioId requerido.' };

	const { valido, error: errorFormato } = _validarPin(pin);
	if (!valido) return { ok: false, error: errorFormato };

	showSpinner();
	try {
		const { data, error } = await supabase.rpc('fn_verificar_pin', {
			p_usuario_id: usuarioId,
			p_pin:        pin,
		});

		if (error) {
			const msg = error.message || '';
			if (msg.includes('ERR_PIN_02') || msg.includes('bloquead')) {
				return { ok: false, error: 'ERR_PIN_02: Cuenta bloqueada por intentos fallidos. Esperá 15 minutos.' };
			}
			if (msg.includes('ERR_PIN_01')) {
				return { ok: false, error: 'ERR_PIN_01: Todavía no configuraste tu PIN de firma.' };
			}
			return { ok: false, error: `ERR_HSE_15: ${msg}` };
		}

		if (!data) return { ok: false, error: 'ERR_PIN_03: PIN incorrecto.' };
		return { ok: true, error: null };

	} catch (e) {
		return { ok: false, error: 'ERR_SYS_03: Sin conexión para verificar PIN.' };
	} finally {
		hideSpinner();
	}
}

/**
 * Establece el PIN inicial del usuario (setup.html).
 *
 * @param {string} usuarioId — UUID del usuario
 * @param {string} pin — PIN en texto plano (4-6 dígitos numéricos)
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function establecerPin(usuarioId, pin) {
	if (!usuarioId) return { ok: false, error: 'ERR_SYS_08: usuarioId requerido.' };

	const { valido, error: errorFormato } = _validarPin(pin);
	if (!valido) return { ok: false, error: errorFormato };

	showSpinner();
	try {
		const { error } = await supabase.rpc('fn_establecer_pin', {
			p_usuario_id: usuarioId,
			p_pin:        pin,
		});

		if (error) {
			_log.error('Error al establecer PIN:', error.message);
			return { ok: false, error: `ERR_HSE_19: No se pudo guardar el PIN. ${error.message}` };
		}

		return { ok: true, error: null };

	} catch (e) {
		return { ok: false, error: 'ERR_SYS_03: Sin conexión para guardar PIN.' };
	} finally {
		hideSpinner();
	}
}

/**
 * Firma un ATS de forma atómica en el servidor (Remediación H-06 y H-07).
 *
 * Contrato verificado contra Migración 1 y 2 en Supabase:
 *   1. Pide un nonce fresco con fn_crear_nonce(session.user.id).
 *      Cada intento de firma (incluso con PIN fallido) quema el nonce en servidor.
 *   2. Invoca fn_firmar_ats({ p_instancia_id, p_nonce, p_pin, p_atshel_local_id }).
 *   3. Si ocurre un corte de red en medio de la respuesta, _withRetry reintenta con
 *      el mismo p_atshel_local_id y recibe { ok: true, ya_firmado: true } sin duplicar firma.
 *   4. Lee errores de negocio desde data.error (incluyendo ERR_PIN_03 con intentos_restantes).
 *
 * @param {{ instanciaId: string, pin: string, localId?: string }} params
 * @returns {Promise<{
 *   ok: boolean,
 *   firmaId?: string|null,
 *   firmadoEn?: string|null,
 *   yaFirmado?: boolean,
 *   codigoError?: string,
 *   intentosRestantes?: number,
 *   error: string|null
 * }>}
 */
export async function firmarAts({ instanciaId, pin, localId = null }) {
	if (!instanciaId) {
		return { ok: false, error: 'ERR_FIR_01: ID de ATS requerido para firmar.' };
	}

	const { valido, error: errorFormato } = _validarPin(pin);
	if (!valido) return { ok: false, error: errorFormato };

	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		return {
			ok:    false,
			error: 'ERR_SYS_03: Se requiere conexión a internet para verificar tu PIN y firmar el ATS.',
		};
	}

	const session = await getSession();
	if (!session?.user?.id) {
		return { ok: false, error: 'ERR_SYS_01: Sesión no válida. Iniciá sesión nuevamente.' };
	}

	const idempotencyKey = localId || (
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`
	);

	showSpinner();
	try {
		// 1. Generar nonce nuevo (se consume siempre en el intento)
		const nonceRes = await crearNonce(session.user.id);
		if (!nonceRes.ok || !nonceRes.nonceId) {
			return {
				ok:    false,
				error: nonceRes.error || 'ERR_FIR_05: No se pudo generar el código único de firma.',
			};
		}

		// 2. Ejecutar RPC transaccional fn_firmar_ats
		const { data, error } = await _withRetry(() =>
			supabase.rpc('fn_firmar_ats', {
				p_instancia_id:    instanciaId,
				p_nonce:           nonceRes.nonceId,
				p_pin:             pin,
				p_atshel_local_id: idempotencyKey,
			})
		);

		if (error) {
			_log.error('Error RPC en fn_firmar_ats:', error.message);
			return {
				ok:    false,
				error: handleSupabaseError(error, 'fn_firmar_ats'),
			};
		}

		// 3. Errores de negocio devueltos como JSON { error, mensaje, intentos_restantes }
		if (data?.error) {
			if (data.error === 'ERR_PIN_03') {
				const rest = data.intentos_restantes;
				const detalle = typeof rest === 'number'
					? ` Te quedan ${rest} intento${rest === 1 ? '' : 's'}.`
					: '';
				return {
					ok:                false,
					codigoError:       data.error,
					intentosRestantes: rest,
					error:             `ERR_PIN_03: PIN incorrecto.${detalle}`,
				};
			}

			if (data.error === 'ERR_PIN_02') {
				return {
					ok:          false,
					codigoError: data.error,
					error:       `ERR_PIN_02: ${data.mensaje || 'Cuenta bloqueada por 15 minutos por intentos fallidos.'}`,
				};
			}

			return {
				ok:          false,
				codigoError: data.error,
				error:       `${data.error}: ${data.mensaje || 'No se pudo firmar el ATS.'}`,
			};
		}

		return {
			ok:        true,
			firmaId:   data?.firma_id ?? null,
			firmadoEn: data?.firmado_en ?? null,
			yaFirmado: Boolean(data?.ya_firmado),
			error:     null,
		};

	} catch (e) {
		_log.error('Excepción de red en firmarAts:', e);
		return {
			ok:    false,
			error: 'ERR_SYS_03: Error de conexión al firmar el ATS. Intentá de nuevo.',
		};
	} finally {
		hideSpinner();
	}
}

// ─────────────────────────────────────────────────────────────
// 9. FUNCIONES RPC DE NEGOCIO
// ─────────────────────────────────────────────────────────────

export async function verificarSesion() {
	try {
		const { data, error } = await supabase.rpc('fn_verificar_sesion');
		if (error) return null;
		return data;
	} catch {
		return null;
	}
}

export async function calcularKpis({ desde = null, hasta = null } = {}) {
	const empresaId = await getEmpresaId();

	try {
		const params = { p_empresa_id: empresaId };
		if (desde) params.p_desde = desde.toISOString().split('T')[0];
		if (hasta) params.p_hasta = hasta.toISOString().split('T')[0];

		const { data, error } = await _withRetry(() =>
			supabase.rpc('fn_calcular_kpis', params)
		);

		if (error) {
			_log.error('Error al calcular KPIs:', error.message);
			return null;
		}

		return data;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────
// 10. TÉRMINOS Y CONDICIONES
// ─────────────────────────────────────────────────────────────

export const terminos = {

	async obtenerVigente() {
		try {
			const { data, error } = await _withRetry(() =>
				supabase
					.from('terminos_versiones')
					.select('id, version, contenido, hash_sha256')
					.eq('activa', true)
					.order('created_at', { ascending: false })
					.limit(1)
					.maybeSingle()
			);

			if (error) {
				_log.error('Error al obtener términos:', error.message);
				return null;
			}

			return data;
		} catch {
			return null;
		}
	},

	async aceptar(versionId) {
		const session = await getSession();
		if (!session) return { ok: false, error: 'ERR_SYS_09: Sesión inválida.' };

		const usuario = await getUsuario();
		if (!usuario?.empresa_id) {
			return { ok: false, error: 'ERR_SYS_09: No se pudo cargar el perfil de usuario.' };
		}

		showSpinner();
		try {
			const { data, error } = await supabase.rpc('fn_aceptar_terminos', {
				p_usuario_id: session.user.id,
				p_empresa_id: usuario.empresa_id,
				p_version_id: versionId,
				p_user_agent: navigator.userAgent.slice(0, 255),
			});

			if (error) {
				return { ok: false, error: `ERR_SYS_10: No se pudo registrar la aceptación. ${error.message}` };
			}

			if (data?.error) {
				return { ok: false, error: `${data.error}: ${data.mensaje}` };
			}

			invalidarCacheUsuario();
			return { ok: true, error: null };

		} catch (e) {
			return { ok: false, error: 'ERR_SYS_03: Sin conexión para registrar aceptación.' };
		} finally {
			hideSpinner();
		}
	},

	async usuarioAcepto() {
		const usuario = await getUsuario();
		if (!usuario) return false;
		return Boolean(usuario.terminos_aceptado_en);
	},
};

// ─────────────────────────────────────────────────────────────
// 11. REGISTRO DE EMPRESA — FLUJO TRANSACCIONAL
// ─────────────────────────────────────────────────────────────

export async function registrarEmpresa({ nombreEmpresa, cuit, nombreCompleto }) {
	const session = await getSession();
	if (!session) return { ok: false, empresaId: null, error: 'ERR_SYS_09: Sesión inválida.' };

	showSpinner();
	try {
		const { data, error } = await supabase.rpc('fn_registrar_empresa', {
			p_user_id:         session.user.id,
			p_nombre_empresa:  nombreEmpresa,
			p_cuit:            cuit,
			p_nombre_completo: nombreCompleto,
		});

		if (error) return { ok: false, empresaId: null, error: `ERR_SYS_30: ${error.message}` };
		if (data?.error) return { ok: false, empresaId: null, error: `${data.error}: ${data.mensaje}` };

		_sessionCache = null;
		invalidarCacheUsuario();

		const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();

		if (refreshError) {
			_log.warn('Empresa creada OK pero refreshSession() falló:', refreshError.message);
		} else if (refreshData?.session) {
			_sessionCache = refreshData.session;
		}

		return { ok: true, empresaId: data.empresa_id, error: null };

	} catch (e) {
		return { ok: false, empresaId: null, error: 'ERR_SYS_03: Sin conexión para registrar empresa.' };
	} finally {
		hideSpinner();
	}
}

// ─────────────────────────────────────────────────────────────
// 12. GUARDS DE NAVEGACIÓN
// ─────────────────────────────────────────────────────────────

export async function requireAuth() {
	const session = await getSession();

	if (!session) {
		throw new ATSHELError('ERR_SYS_11', 'Sin sesión activa.');
	}

	return session;
}

export async function requireRole(...rolesPermitidos) {
	await requireAuth();

	const rol = await getRol();

	if (!rolesPermitidos.includes(rol)) {
		showToast('No tenés permiso para acceder a esta sección.', 'error');
		throw new ATSHELError(
			'ERR_SYS_12',
			`Rol '${rol}' no autorizado.`,
			{ requerido: rolesPermitidos, actual: rol }
		);
	}

	return rol;
}

// ─────────────────────────────────────────────────────────────
// 13. HELPER: MANEJO DE ERRORES DE SUPABASE
// ─────────────────────────────────────────────────────────────

export function handleSupabaseError(error, contexto = '') {
	if (!error) return '';

	const msg = error.message || 'Error desconocido';
	_log.error(`${contexto}:`, error);

	if (msg.startsWith('IDEMPOTENT:')) {
		return 'Este registro ya fue guardado anteriormente.';
	}

	if (msg.includes('ATS_LOCK')) {
		return 'Este ATS ya está firmado y bloqueado. No admite modificaciones.';
	}

	if (msg.includes('ERR_HSE_18')) {
		return 'ERR_HSE_18: La firma del ATS requiere validación de PIN en el servidor.';
	}

	if (msg.includes('ERR_HSE_19')) {
		return 'ERR_HSE_19: Las firmas registradas son inmutables y no pueden modificarse.';
	}

	if (msg.includes('version') && msg.includes('ERR_HSE')) {
		return 'ERR_HSE_20: Este registro fue modificado por otro usuario. Recargá y volvé a intentar.';
	}

	if (error.code === '42501' || msg.includes('row-level security')) {
		return 'ERR_SYS_13: No tenés permiso para realizar esta operación.';
	}

	if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
		return 'ERR_SYS_03: Sin conexión. La operación se guardará cuando vuelva la señal.';
	}

	return `ERR_SYS_14: ${msg}`;
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-supabase.js v3.2.0
// ─────────────────────────────────────────────────────────────
