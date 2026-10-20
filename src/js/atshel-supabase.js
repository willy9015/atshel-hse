/**
 * atshel-supabase.js
 * Cliente Supabase para ATSHEL HSE Manager.
 * Argumentos RPC verificados contra schema real (MCP 2026-06-14).
 *
 * v3.1.0 — Blindaje Offline MPA y Aislamiento de Sesión
 *
 * Cambios incorporados:
 *   1. ATSHELError — clase de error unificada con código estandarizado.
 *   2. Caché de usuario en RAM + localStorage aislado por user.id (`atshel_usuario_cache_<uuid>`)
 *      para que al navegar entre páginas MPA (index.html -> ats-nuevo.html) sin señal
 *      no se pierda el perfil ni se produzcan cruces entre cuentas.
 *   3. _withRetry() — reintentos automáticos en RPC con backoff exponencial y
 *      corte instantáneo (0ms) si navigator.onLine === false.
 *   4. getEmpresaId() / getRol() — fallback a public.usuarios cuando el JWT
 *      no tiene app_metadata (hook ejecutado antes de que existiera la fila).
 *   5. getUsuario() — .maybeSingle() + recuperación instantánea desde localStorage en offline.
 *   6. onAuthStateChange (SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED, SIGNED_OUT) —
 *      detecta cambios de cuenta y purga cachés de usuario y media del Service Worker.
 *   7. terminos.aceptar() — RPC transaccional fn_aceptar_terminos().
 *      Lee empresa_id de public.usuarios, no del JWT.
 *   8. registrarEmpresa() — refreshSession() después de crear la empresa.
 *   9. logout() — soporta cierre de sesión sin señal ({ scope: 'local' }), limpia
 *      localStorage y devuelve control al caller (atshel-app.js).
 *  10. _validarPin() — validación de PIN centralizada.
 *
 * Exporta:
 *   supabase, ATSHELError,
 *   getSession(), getUsuario(), getEmpresaId(), getRol(),
 *   invalidarCacheUsuario(),
 *   login(), logout(), recuperarPassword(),
 *   crearNonce(), verificarPin(), establecerPin(),
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
 * Todos los errores del módulo usan esta clase para
 * facilitar el manejo centralizado en atshel-app.js.
 *
 * Códigos ERR_SYS_XX: errores de infraestructura (auth, red, permisos)
 * Códigos ERR_HSE_XX: errores de dominio (PIN, gases, arnés)
 * Códigos ERR_REG_XX: errores de registro/onboarding
 * Códigos ERR_TRM_XX: errores de términos y condiciones
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

	/** Retorna objeto plano para logs y telemetría */
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
			'X-Client-Info': 'atshel-hse/3.1',
		},
	},
});

// ─────────────────────────────────────────────────────────────
// 3. CACHÉ DE SESIÓN Y USUARIO (RAM + LOCALSTORAGE AISLADO POR USER_ID)
// ─────────────────────────────────────────────────────────────

// TTL del caché de usuario en ms cuando hay señal (5 minutos)
const USUARIO_CACHE_TTL    = 5 * 60 * 1_000;
const USUARIO_STORAGE_PREF = 'atshel_usuario_cache_';

let _sessionCache   = null;
let _usuarioCache   = null;
let _usuarioCacheTs = 0;

/**
 * Guarda el perfil en localStorage atado al UUID del usuario autenticado.
 * Evita que al navegar entre páginas MPA (index.html -> ats-nuevo.html)
 * sin señal en el pozo se pierda el perfil en RAM.
 *
 * @param {string} userId
 * @param {Object} data
 */
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

/**
 * Lee el perfil persistido únicamente si coincide exactamente con el userId actual.
 *
 * @param {string} userId
 * @returns {{ data: Object, ts: number }|null}
 */
function _leerUsuarioStorage(userId) {
	if (!userId) return null;
	try {
		const raw = localStorage.getItem(`${USUARIO_STORAGE_PREF}${userId}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed?.data?.id !== userId) return null; // Blindaje anti-cruce de cuentas
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Invalida el caché del usuario en RAM y elimina todos los perfiles
 * persistidos en localStorage.
 * Llamar después de operaciones que modifican public.usuarios o al cerrar sesión.
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

/**
 * Sincroniza el estado de sesión con eventos de Supabase Auth.
 * Garantiza aislamiento estricto al cambiar de cuenta o cerrar sesión.
 */
supabase.auth.onAuthStateChange((event, session) => {
	if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session) {
		const prevUserId = _sessionCache?.user?.id;
		_sessionCache = session;

		// Si cambió el usuario autenticado, purgar todo el almacenamiento de perfiles
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
// 4. HELPER: RETRY CON BACKOFF EXPONENCIAL (CON CORTE RÁPIDO OFFLINE)
// ─────────────────────────────────────────────────────────────

const RETRY_DELAYS = [500, 1_500, 3_000]; // ms

/**
 * Ejecuta una función async con reintentos automáticos.
 * Solo reintenta en errores de red cuando el dispositivo tiene conexión.
 * Si navigator.onLine === false, aborta en 0ms sin bloquear la UI.
 *
 * @template T
 * @param {() => Promise<T>} fn — Función a ejecutar
 * @param {number} [maxIntentos=3] — Máximo de intentos
 * @returns {Promise<T>}
 */
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

/**
 * Retorna la sesión actual o null si no hay sesión activa.
 * Lee de localStorage primero (sin red) — solo va al servidor
 * cuando el token expira y autoRefreshToken lo renueva.
 *
 * @returns {Promise<import('@supabase/supabase-js').Session|null>}
 */
export async function getSession() {
	if (_sessionCache) return _sessionCache;

	const { data, error } = await supabase.auth.getSession();
	if (error || !data?.session) return null;

	_sessionCache = data.session;
	return _sessionCache;
}

/**
 * Retorna los datos del usuario desde public.usuarios.
 * Caché en RAM + localStorage con TTL de 5 minutos cuando hay red,
 * y fallback instantáneo sin vencimiento cuando el dispositivo está offline.
 *
 * Columnas verificadas MCP 2026-06-14:
 * id, empresa_id, rol, nombre_completo, oficio, tipo_trabajo_id,
 * es_nuevo_ingresante, fecha_ingreso, induccion_completada,
 * terminos_aceptado_en, activo, tutor_id.
 *
 * @returns {Promise<Object|null>}
 */
export async function getUsuario() {
	const session = await getSession();
	if (!session?.user?.id) return null;

	const userId = session.user.id;
	const ahora  = Date.now();

	// 1. Verificar caché en RAM (validando que pertenezca al mismo userId)
	if (_usuarioCache && _usuarioCache.id === userId && (ahora - _usuarioCacheTs) < USUARIO_CACHE_TTL) {
		return _usuarioCache;
	}

	// 2. Leer respaldo persistido en localStorage para este userId
	const persistido = _leerUsuarioStorage(userId);

	// Si el operador está sin señal en campo, retornar respaldo local en 0ms
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		if (persistido?.data) {
			_usuarioCache   = persistido.data;
			_usuarioCacheTs = persistido.ts;
			return _usuarioCache;
		}
		return null;
	}

	// Si el respaldo de localStorage fue guardado hace menos de 5 min (ej. cambio de página MPA), reutilizarlo
	if (persistido?.data && (ahora - persistido.ts) < USUARIO_CACHE_TTL) {
		_usuarioCache   = persistido.data;
		_usuarioCacheTs = persistido.ts;
		return _usuarioCache;
	}

	// 3. Consultar a Supabase cuando hay red y el TTL expiró
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

/**
 * Lee empresa_id — JWT primero, fallback a public.usuarios.
 *
 * @returns {Promise<string|null>} UUID de empresa o null
 */
export async function getEmpresaId() {
	const session = await getSession();
	if (!session) return null;

	const fromJwt = session.user?.app_metadata?.empresa_id ?? null;
	if (fromJwt) return fromJwt;

	_log.warn(
		'JWT sin empresa_id en app_metadata. ' +
		'Usando fallback a public.usuarios. ' +
		'Verificar custom_access_token_hook → Supabase Dashboard → Auth → Hooks.'
	);
	const usuario = await getUsuario();
	return usuario?.empresa_id ?? null;
}

/**
 * Lee rol — JWT primero, fallback a public.usuarios.
 * Valores válidos verificados MCP: 'administrador' | 'supervisor' | 'hse'
 *
 * @returns {Promise<string|null>}
 */
export async function getRol() {
	const session = await getSession();
	if (!session) return null;

	const fromJwt = session.user?.app_metadata?.rol ?? null;
	if (fromJwt) return fromJwt;

	_log.warn(
		'JWT sin rol en app_metadata. ' +
		'Usando fallback a public.usuarios. ' +
		'Verificar custom_access_token_hook → Supabase Dashboard → Auth → Hooks.'
	);
	const usuario = await getUsuario();
	return usuario?.rol ?? null;
}

// ─────────────────────────────────────────────────────────────
// 6. AUTENTICACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Inicia sesión con email y contraseña.
 * Limpia cualquier caché previo antes de establecer la nueva sesión.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
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

/**
 * Cierra la sesión del usuario actual (online y offline).
 *
 * NO redirige — devuelve control al caller (atshel-app.js).
 * Si el dispositivo está sin señal, fuerza el cierre local ({ scope: 'local' })
 * y purga el almacenamiento para impedir que la sesión quede abierta.
 *
 * @returns {Promise<void>}
 */
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

/**
 * Envía email de recuperación de contraseña.
 *
 * @param {string} email
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
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

/**
 * Traduce mensajes de error de Supabase Auth a español argentino.
 * @param {string} msg
 * @returns {string}
 */
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

/**
 * Valida formato de PIN antes de enviarlo al backend.
 * @param {string} pin
 * @returns {{ valido: boolean, error: string|null }}
 */
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
// 8. PIN — RPC VERIFICADOS CON MCP
//
//    fn_crear_nonce(p_usuario_id uuid) → uuid
//    fn_verificar_pin(p_usuario_id uuid, p_pin text) → boolean
//    fn_establecer_pin(p_usuario_id uuid, p_pin text) → void
// ─────────────────────────────────────────────────────────────

/**
 * Solicita un nonce de firma de un solo uso.
 * Llamar inmediatamente antes de verificarPin().
 *
 * @param {string} usuarioId — UUID del usuario que va a firmar
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
		return { ok: false, nonceId: null, error: 'ERR_SYS_03: Sin conexión para crear nonce.' };
	}
}

/**
 * Verifica el PIN del usuario para completar una firma digital.
 * El backend realiza el bcrypt compare y maneja los intentos fallidos.
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
			if (msg.includes('bloqueado') || msg.includes('BLOQUEADO')) {
				return { ok: false, error: 'ERR_HSE_13: Cuenta bloqueada por intentos fallidos. Esperá 15 minutos.' };
			}
			if (msg.includes('intentos')) {
				return { ok: false, error: `ERR_HSE_14: PIN incorrecto. ${msg}` };
			}
			return { ok: false, error: `ERR_HSE_15: Error al verificar PIN. ${msg}` };
		}

		if (!data) return { ok: false, error: 'ERR_HSE_16: PIN incorrecto.' };
		return { ok: true, error: null };

	} catch (e) {
		return { ok: false, error: 'ERR_SYS_03: Sin conexión para verificar PIN.' };
	} finally {
		hideSpinner();
	}
}

/**
 * Establece el PIN inicial del usuario (solo en setup.html).
 * No llamar si el usuario ya tiene PIN configurado.
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

// ─────────────────────────────────────────────────────────────
// 9. FUNCIONES RPC DE NEGOCIO
// ─────────────────────────────────────────────────────────────

/**
 * Verifica que la sesión actual es válida.
 * @returns {Promise<Object|null>}
 */
export async function verificarSesion() {
	try {
		const { data, error } = await supabase.rpc('fn_verificar_sesion');
		if (error) return null;
		return data;
	} catch {
		return null;
	}
}

/**
 * Calcula KPIs de seguridad para el dashboard.
 *
 * @param {{ desde?: Date, hasta?: Date }} opciones
 * @returns {Promise<Object|null>}
 */
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

	/**
	 * Obtiene la versión de términos vigente (activa = true).
	 * @returns {Promise<{ id: string, version: string, contenido: string, hash_sha256: string }|null>}
	 */
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

	/**
	 * Registra la aceptación de los términos por parte del usuario.
	 *
	 * Usa RPC transaccional fn_aceptar_terminos() que hace
	 * INSERT en terminos_aceptaciones Y UPDATE en usuarios en una sola
	 * transacción atómica.
	 *
	 * Lee empresa_id de public.usuarios — NO del JWT — para que funcione
	 * incluso cuando el JWT aún no tiene empresa_id (primer login).
	 *
	 * @param {string} versionId — UUID de terminos_versiones.id
	 * @returns {Promise<{ ok: boolean, error: string|null }>}
	 */
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

			// Invalidar caché para que el próximo getUsuario() recargue terminos_aceptado_en
			invalidarCacheUsuario();
			return { ok: true, error: null };

		} catch (e) {
			return { ok: false, error: 'ERR_SYS_03: Sin conexión para registrar aceptación.' };
		} finally {
			hideSpinner();
		}
	},

	/**
	 * Verifica si el usuario ya aceptó los términos vigentes.
	 * @returns {Promise<boolean>}
	 */
	async usuarioAcepto() {
		const usuario = await getUsuario();
		if (!usuario) return false;
		return Boolean(usuario.terminos_aceptado_en);
	},
};

// ─────────────────────────────────────────────────────────────
// 11. REGISTRO DE EMPRESA — FLUJO TRANSACCIONAL
// ─────────────────────────────────────────────────────────────

/**
 * Registra una nueva empresa y asigna al usuario actual como administrador.
 *
 * @param {{ nombreEmpresa: string, cuit: string, nombreCompleto: string }} datos
 * @returns {Promise<{ ok: boolean, empresaId: string|null, error: string|null }>}
 */
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
			_log.warn(
				'Empresa creada OK pero refreshSession() falló:',
				refreshError.message,
				'— fallback en getEmpresaId() se encargará.'
			);
		} else if (refreshData?.session) {
			_sessionCache = refreshData.session;
			_log.info('JWT refrescado — empresa_id inyectado correctamente.');
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

/**
 * Verifica que hay sesión activa.
 * NO redirige — lanza ATSHELError. La redirección la hace el caller (atshel-app.js).
 *
 * @returns {Promise<import('@supabase/supabase-js').Session>}
 * @throws {ATSHELError} ERR_SYS_11 si no hay sesión
 */
export async function requireAuth() {
	const session = await getSession();

	if (!session) {
		throw new ATSHELError('ERR_SYS_11', 'Sin sesión activa.');
	}

	return session;
}

/**
 * Verifica que el usuario tiene uno de los roles requeridos.
 * Roles válidos MCP: 'administrador' | 'supervisor' | 'hse'
 *
 * @param {...string} rolesPermitidos
 * @returns {Promise<string>} El rol del usuario si tiene acceso
 * @throws {ATSHELError} ERR_SYS_12 si el rol no tiene acceso
 */
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

/**
 * Maneja errores de Supabase de forma consistente.
 * Traduce códigos técnicos a mensajes legibles para el usuario.
 *
 * @param {Object} error — objeto error de Supabase
 * @param {string} [contexto=''] — descripción de la operación para el log
 * @returns {string} Mensaje de error para mostrar al usuario
 */
export function handleSupabaseError(error, contexto = '') {
	if (!error) return '';

	const msg = error.message || 'Error desconocido';
	_log.error(`${contexto}:`, error);

	if (msg.startsWith('IDEMPOTENT:')) {
		return 'Este registro ya fue guardado anteriormente.';
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
// FIN DE atshel-supabase.js v3.1.0
// ─────────────────────────────────────────────────────────────
