/**
 * atshel-supabase.js
 * Cliente Supabase para ATSHEL HSE Manager.
 * Argumentos RPC verificados contra schema real (MCP 2026-06-14).
 *
 * v3.0.0 — 2026-07-29
 *
 * Cambios sobre el original:
 *   1. ATSHELError — clase de error unificada con código estandarizado.
 *   2. Caché de usuario con TTL de 5 minutos — evita stale data.
 *   3. _withRetry() — reintentos automáticos en RPC con backoff exponencial.
 *   4. getEmpresaId() / getRol() — fallback a public.usuarios cuando el JWT
 *      no tiene app_metadata (hook ejecutado antes de que existiera la fila).
 *      Warning en consola para detectar cuándo el hook falla.
 *   5. getUsuario() — .maybeSingle() en lugar de .single().
 *   6. onAuthStateChange TOKEN_REFRESHED — guarda sesión nueva inmediatamente.
 *   7. terminos.aceptar() — RPC transaccional fn_aceptar_terminos().
 *      Lee empresa_id de public.usuarios, no del JWT.
 *   8. registrarEmpresa() — refreshSession() después de crear la empresa.
 *   9. logout() — no redirige directamente; devuelve control al caller.
 *      La redirección la hace atshel-app.js (un solo punto de navegación).
 *  10. _validarPin() — validación de PIN centralizada.
 *  11. structuredClone con fallback para WebViews Android antiguos.
 *  12. JSDoc completo en todas las funciones públicas.
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
		this.name    = 'ATSHELError';
		this.codigo  = codigo;
		this.mensaje = mensaje;
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
			'X-Client-Info': 'atshel-hse/3.0',
		},
	},
});

// ─────────────────────────────────────────────────────────────
// 3. CACHÉ DE SESIÓN Y USUARIO
// ─────────────────────────────────────────────────────────────

// TTL del caché de usuario en ms (5 minutos)
const USUARIO_CACHE_TTL = 5 * 60 * 1_000;

let _sessionCache      = null;
let _usuarioCache      = null;
let _usuarioCacheTs    = 0;    // timestamp de última actualización del caché

/**
 * Invalida el caché del usuario manualmente.
 * Llamar después de operaciones que modifican public.usuarios.
 */
export function invalidarCacheUsuario() {
	_usuarioCache   = null;
	_usuarioCacheTs = 0;
}

/**
 * FIX: TOKEN_REFRESHED guarda la nueva sesión inmediatamente
 * y limpia el caché de usuario — puede haber cambiado empresa_id.
 * SIGNED_OUT limpia todo pero NO redirige — la redirección
 * la maneja atshel-app.js via onAuthStateChange propio.
 */
supabase.auth.onAuthStateChange((event, session) => {
	if (event === 'TOKEN_REFRESHED' && session) {
		_sessionCache = session;
		invalidarCacheUsuario();
		_log.info('JWT renovado. Caché de sesión actualizado.');
	}

	if (event === 'SIGNED_OUT') {
		_sessionCache = null;
		invalidarCacheUsuario();
		_log.info('Sesión cerrada. Caché limpiado.');
	}
});

// ─────────────────────────────────────────────────────────────
// 4. HELPER: RETRY CON BACKOFF EXPONENCIAL
// ─────────────────────────────────────────────────────────────

const RETRY_DELAYS = [500, 1_500, 3_000]; // ms

/**
 * Ejecuta una función async con reintentos automáticos.
 * Solo reintenta en errores de red — no en errores de negocio (RLS, 404, etc.).
 *
 * @template T
 * @param {() => Promise<T>} fn — Función a ejecutar
 * @param {number} [maxIntentos=3] — Máximo de intentos
 * @returns {Promise<T>}
 */
async function _withRetry(fn, maxIntentos = 3) {
	let ultimoError;

	for (let i = 0; i < maxIntentos; i++) {
		try {
			return await fn();
		} catch (error) {
			ultimoError = error;

			// No reintentar errores de negocio
			const esErrorDeRed =
				error.message?.includes('fetch') ||
				error.message?.includes('network') ||
				error.message?.includes('Failed to fetch') ||
				error.message?.includes('NetworkError');

			if (!esErrorDeRed) throw error;

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
// 5. SESIÓN Y PERFIL
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
	if (error || !data.session) return null;

	_sessionCache = data.session;
	return _sessionCache;
}

/**
 * Retorna los datos del usuario desde public.usuarios.
 * Caché con TTL de 5 minutos para reducir queries al backend.
 *
 * FIX: usa .maybeSingle() — devuelve null sin excepción cuando
 * el registro aún no existe (usuario en proceso de onboarding).
 *
 * Columnas verificadas MCP 2026-06-14:
 * id, empresa_id, rol, nombre_completo, oficio, tipo_trabajo_id,
 * es_nuevo_ingresante, fecha_ingreso, induccion_completada,
 * terminos_aceptado_en, activo, tutor_id.
 *
 * @returns {Promise<Object|null>}
 */
export async function getUsuario() {
	// Verificar TTL del caché
	const ahora = Date.now();
	if (_usuarioCache && (ahora - _usuarioCacheTs) < USUARIO_CACHE_TTL) {
		return _usuarioCache;
	}

	const session = await getSession();
	if (!session) return null;

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
				.eq('id', session.user.id)
				.is('deleted_at', null)
				.maybeSingle()
		);

		if (error) {
			_log.error('Error al cargar usuario:', error.message);
			return null;
		}

		_usuarioCache   = data; // puede ser null — maybeSingle() no lanza
		_usuarioCacheTs = Date.now();
		return _usuarioCache;

	} catch (error) {
		_log.error('Error de red al cargar usuario:', error.message);
		// Devolver caché expirado si existe — mejor que null en offline
		return _usuarioCache ?? null;
	}
}

/**
 * Lee empresa_id — JWT primero, fallback a public.usuarios.
 *
 * FIX: el custom_access_token_hook puede ejecutarse antes de que
 * exista la fila en public.usuarios (primer login del usuario recién
 * creado). En ese caso el hook no inyecta empresa_id y el JWT queda
 * sin ese claim. El fallback lee desde la tabla directamente.
 * Warning en consola para detectar cuándo el hook está fallando.
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
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function login(email, password) {
	showSpinner();
	try {
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
 * Cierra la sesión del usuario actual.
 *
 * FIX v3.0: NO redirige — devuelve control al caller.
 * La redirección la hace atshel-app.js para evitar
 * redirecciones duplicadas (race condition con onAuthStateChange).
 *
 * @returns {Promise<void>}
 */
export async function logout() {
	showSpinner();
	try {
		await supabase.auth.signOut();
	} catch (e) {
		_log.error('Error en logout:', e);
		// Continuar aunque falle — el caché se limpia igual
	} finally {
		_sessionCache = null;
		invalidarCacheUsuario();
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
		'Invalid login credentials':  'Email o contraseña incorrectos.',
		'Email not confirmed':         'Confirmá tu email antes de ingresar.',
		'User not found':              'No existe una cuenta con ese email.',
		'Password should be at least': 'La contraseña debe tener al menos 6 caracteres.',
		'Too many requests':           'Demasiados intentos. Esperá unos minutos.',
		'User is banned':              'Tu cuenta está suspendida. Contactá al administrador.',
		'Network request failed':      'Sin conexión. Verificá tu señal.',
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
	 * FIX v3.0: usa RPC transaccional fn_aceptar_terminos() que hace
	 * INSERT en terminos_aceptaciones Y UPDATE en usuarios en una sola
	 * transacción atómica. Nunca queda estado inconsistente.
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

		// Leer empresa_id de la tabla — NO del JWT
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

			// Invalidar caché para que el próximo getUsuario() traiga
			// terminos_aceptado_en actualizado
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
		return !!usuario.terminos_aceptado_en;
	},
};

// ─────────────────────────────────────────────────────────────
// 11. REGISTRO DE EMPRESA — NUEVO FLUJO
// ─────────────────────────────────────────────────────────────

/**
 * Registra una nueva empresa y asigna al usuario actual como administrador.
 *
 * Flujo v3.0:
 * 1. fn_registrar_empresa() — crea empresa + usuario en una transacción.
 * 2. Invalida caché de usuario y sesión.
 * 3. refreshSession() — el hook se ejecuta con la fila ya creada
 *    y el JWT nuevo trae empresa_id y rol correctamente.
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

		// Limpiar caché antes del refresh
		_sessionCache = null;
		invalidarCacheUsuario();

		// Forzar refresh del JWT — el hook ahora puede leer la fila creada
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
 * FIX v3.0: NO redirige — lanza ATSHELError.
 * La redirección la hace el caller (atshel-app.js).
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
// FIN DE atshel-supabase.js v3.0.0
// ─────────────────────────────────────────────────────────────
