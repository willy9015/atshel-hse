/**
 * atshel-supabase.js
 * Cliente Supabase para ATSHEL.
 * Argumentos de funciones RPC verificados contra schema real (MCP 2026-06-14).
 *
 * Dependencias:
 *   - @supabase/supabase-js (instalado via npm, importado via Vite)
 *   - atshel-core.js (showToast, showSpinner, hideSpinner)
 *
 * Exporta:
 *   - supabase               Cliente inicializado
 *   - getSession()
 *   - getUsuario()
 *   - getEmpresaId()
 *   - getRol()
 *   - login(email, pass)
 *   - logout()
 *   - recuperarPassword(email)
 *   - crearNonce(usuarioId)
 *   - verificarPin(usuarioId, pin)
 *   - establecerPin(usuarioId, pin)
 *   - verificarSesion()
 *   - calcularKpis(opciones)
 *   - terminos.obtenerVigente()
 *   - terminos.aceptar(versionId)
 *   - terminos.usuarioAcepto()
 *   - requireAuth()
 *   - requireRole(...roles)
 */

import { createClient } from '@supabase/supabase-js';
import {
	showToast,
	showSpinner,
	hideSpinner,
} from './atshel-core.js';

// ─────────────────────────────────────────────────────────────
// 1. INICIALIZACIÓN DEL CLIENTE
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON) {
	throw new Error(
		'[ATSHEL] ERR_SYS_01: Variables de entorno faltantes. ' +
		'Definí VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env.local'
	);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
	auth: {
		// Persistir sesión en localStorage para que sobreviva recargas
		persistSession:     true,
		storageKey:         'atshel_session',
		autoRefreshToken:   true,
		detectSessionInUrl: false,  // No usar OAuth redirects (prohibido — incompatible con COOP)
	},
	global: {
		headers: {
			'X-Client-Info': 'atshel-hse/1.0',
		},
	},
});

// ─────────────────────────────────────────────────────────────
// 2. CACHÉ DE SESIÓN Y USUARIO
//    Evita llamadas repetidas al backend en cada pantalla.
// ─────────────────────────────────────────────────────────────

let _sessionCache  = null;
let _usuarioCache  = null;

// Limpiar caché cuando la sesión cambia
supabase.auth.onAuthStateChange((event) => {
	if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
		_sessionCache = null;
		_usuarioCache = null;
	}
	if (event === 'SIGNED_OUT') {
		// Redirigir a login en cualquier pantalla que esté abierta
		if (!window.location.pathname.includes('/login.html')) {
			window.location.href = '/login.html';
		}
	}
});

// ─────────────────────────────────────────────────────────────
// 3. SESIÓN Y PERFIL
// ─────────────────────────────────────────────────────────────

/**
 * Retorna la sesión actual o null si no hay sesión activa.
 * Usa caché interna — no llama al servidor en cada invocación.
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
 * Lee empresa_id del JWT (app_metadata).
 * NO hace query a la tabla usuarios — lee del token local.
 * @returns {Promise<string|null>} UUID de empresa o null
 */
export async function getEmpresaId() {
	const session = await getSession();
	if (!session) return null;
	return session.user?.app_metadata?.empresa_id ?? null;
}

/**
 * Lee rol del JWT (app_metadata).
 * Valores válidos verificados: 'administrador' | 'supervisor' | 'hse'
 * @returns {Promise<string|null>}
 */
export async function getRol() {
	const session = await getSession();
	if (!session) return null;
	return session.user?.app_metadata?.rol ?? null;
}

/**
 * Retorna los datos del usuario desde la tabla `public.usuarios`.
 * Incluye: nombre_completo, rol, oficio, es_nuevo_ingresante,
 *          induccion_completada, terminos_aceptado_en, activo.
 *
 * Columnas verificadas con MCP 2026-06-14.
 *
 * @returns {Promise<Object|null>}
 */
export async function getUsuario() {
	if (_usuarioCache) return _usuarioCache;

	const session = await getSession();
	if (!session) return null;

	const { data, error } = await supabase
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
		.single();

	if (error) {
		console.error('[ATSHEL] Error al cargar usuario:', error.message);
		return null;
	}

	_usuarioCache = data;
	return _usuarioCache;
}

// ─────────────────────────────────────────────────────────────
// 4. AUTENTICACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Inicia sesión con email y contraseña.
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

		if (error) {
			const msg = _traducirErrorAuth(error.message);
			return { ok: false, error: msg };
		}

		if (!data.session) {
			return { ok: false, error: 'ERR_SYS_02: No se pudo iniciar sesión. Intentá de nuevo.' };
		}

		_sessionCache = data.session;
		return { ok: true, error: null };

	} catch (e) {
		console.error('[ATSHEL] Error inesperado en login:', e);
		return { ok: false, error: 'ERR_SYS_03: Error de conexión. Verificá tu señal.' };
	} finally {
		hideSpinner();
	}
}

/**
 * Cierra la sesión del usuario actual.
 * Limpia caché y redirige a login.html.
 */
export async function logout() {
	showSpinner();
	try {
		await supabase.auth.signOut();
		_sessionCache = null;
		_usuarioCache = null;
		window.location.href = '/login.html';
	} catch (e) {
		console.error('[ATSHEL] Error en logout:', e);
		// Forzar redirección igual
		window.location.href = '/login.html';
	} finally {
		hideSpinner();
	}
}

/**
 * Envía email de recuperación de contraseña.
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

		if (error) {
			return { ok: false, error: _traducirErrorAuth(error.message) };
		}

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
		'Invalid login credentials':           'Email o contraseña incorrectos.',
		'Email not confirmed':                  'Confirmá tu email antes de ingresar.',
		'User not found':                       'No existe una cuenta con ese email.',
		'Password should be at least':         'La contraseña debe tener al menos 6 caracteres.',
		'Too many requests':                   'Demasiados intentos. Esperá unos minutos.',
		'User is banned':                      'Tu cuenta está suspendida. Contactá al administrador.',
		'Network request failed':              'Sin conexión. Verificá tu señal.',
	};

	for (const [key, value] of Object.entries(map)) {
		if (msg.includes(key)) return value;
	}

	return `ERR_SYS_05: ${msg}`;
}

// ─────────────────────────────────────────────────────────────
// 5. PIN — ARGUMENTOS VERIFICADOS CON MCP
//
//    fn_crear_nonce(p_usuario_id uuid) → uuid
//    fn_verificar_pin(p_usuario_id uuid, p_pin text) → boolean
//    fn_establecer_pin(p_usuario_id uuid, p_pin text) → void
//
//    IMPORTANTE: fn_verificar_pin NO recibe nonce_id.
//    El nonce se gestiona internamente en el backend.
// ─────────────────────────────────────────────────────────────

/**
 * Solicita un nonce de firma de un solo uso.
 * Debe llamarse inmediatamente antes de verificarPin().
 *
 * Firma real (verificada MCP): fn_crear_nonce(p_usuario_id uuid) → uuid
 *
 * @param {string} usuarioId — UUID del usuario que va a firmar
 * @returns {Promise<{ ok: boolean, nonceId: string|null, error: string|null }>}
 */
export async function crearNonce(usuarioId) {
	if (!usuarioId) {
		return { ok: false, nonceId: null, error: 'ERR_SYS_06: usuarioId requerido para crear nonce.' };
	}

	try {
		const { data, error } = await supabase.rpc('fn_crear_nonce', {
			p_usuario_id: usuarioId,
		});

		if (error) {
			console.error('[ATSHEL] Error al crear nonce:', error.message);
			return { ok: false, nonceId: null, error: 'ERR_HSE_10: No se pudo generar el código de firma.' };
		}

		return { ok: true, nonceId: data, error: null };
	} catch (e) {
		return { ok: false, nonceId: null, error: 'ERR_SYS_03: Sin conexión para crear nonce.' };
	}
}

/**
 * Verifica el PIN del usuario para completar una firma digital.
 *
 * Firma real (verificada MCP): fn_verificar_pin(p_usuario_id uuid, p_pin text) → boolean
 *
 * @param {string} usuarioId — UUID del usuario
 * @param {string} pin — PIN en texto plano (el backend hace el bcrypt)
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function verificarPin(usuarioId, pin) {
	if (!usuarioId || !pin) {
		return { ok: false, error: 'ERR_SYS_07: usuarioId y pin son requeridos.' };
	}

	if (pin.length < 4 || pin.length > 6) {
		return { ok: false, error: 'ERR_HSE_11: El PIN debe tener entre 4 y 6 dígitos.' };
	}

	if (!/^\d+$/.test(pin)) {
		return { ok: false, error: 'ERR_HSE_12: El PIN solo puede contener números.' };
	}

	showSpinner();
	try {
		const { data, error } = await supabase.rpc('fn_verificar_pin', {
			p_usuario_id: usuarioId,
			p_pin:        pin,
		});

		if (error) {
			// El backend retorna ERR_HSE_XX en el mensaje cuando bloquea
			const msg = error.message || '';

			if (msg.includes('bloqueado') || msg.includes('BLOQUEADO')) {
				return { ok: false, error: 'ERR_HSE_13: Cuenta bloqueada por intentos fallidos. Esperá 15 minutos.' };
			}

			if (msg.includes('intentos')) {
				return { ok: false, error: `ERR_HSE_14: PIN incorrecto. ${msg}` };
			}

			return { ok: false, error: `ERR_HSE_15: Error al verificar PIN. ${msg}` };
		}

		if (!data) {
			return { ok: false, error: 'ERR_HSE_16: PIN incorrecto.' };
		}

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
 * Firma real (verificada MCP): fn_establecer_pin(p_usuario_id uuid, p_pin text) → void
 *
 * @param {string} usuarioId — UUID del usuario
 * @param {string} pin — PIN en texto plano (4-6 dígitos)
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function establecerPin(usuarioId, pin) {
	if (!usuarioId || !pin) {
		return { ok: false, error: 'ERR_SYS_08: usuarioId y pin son requeridos.' };
	}

	if (pin.length < 4 || pin.length > 6) {
		return { ok: false, error: 'ERR_HSE_17: El PIN debe tener entre 4 y 6 dígitos.' };
	}

	if (!/^\d+$/.test(pin)) {
		return { ok: false, error: 'ERR_HSE_18: El PIN solo puede contener números.' };
	}

	showSpinner();
	try {
		const { error } = await supabase.rpc('fn_establecer_pin', {
			p_usuario_id: usuarioId,
			p_pin:        pin,
		});

		if (error) {
			console.error('[ATSHEL] Error al establecer PIN:', error.message);
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
// 6. FUNCIONES RPC DE NEGOCIO
// ─────────────────────────────────────────────────────────────

/**
 * Verifica que la sesión actual es válida y retorna datos del usuario.
 * Firma real: fn_verificar_sesion() → jsonb
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
 * Firma real: fn_calcular_kpis(p_empresa_id, p_desde, p_hasta) → jsonb
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

		const { data, error } = await supabase.rpc('fn_calcular_kpis', params);

		if (error) {
			console.error('[ATSHEL] Error al calcular KPIs:', error.message);
			return null;
		}

		return data;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────
// 7. TÉRMINOS Y CONDICIONES
// ─────────────────────────────────────────────────────────────

export const terminos = {

	/**
	 * Obtiene la versión de términos vigente (activa = true).
	 * @returns {Promise<{ id, version, contenido, hash_sha256 }|null>}
	 */
	async obtenerVigente() {
		const { data, error } = await supabase
			.from('terminos_versiones')
			.select('id, version, contenido, hash_sha256')
			.eq('activa', true)
			.order('created_at', { ascending: false })
			.limit(1)
			.single();

		if (error) {
			console.error('[ATSHEL] Error al obtener términos:', error.message);
			return null;
		}

		return data;
	},

	/**
	 * Registra la aceptación de los términos por parte del usuario.
	 * Columnas verificadas: usuario_id, empresa_id, terminos_version_id, aceptado_en, user_agent
	 *
	 * @param {string} versionId — UUID de terminos_versiones.id
	 * @returns {Promise<{ ok: boolean, error: string|null }>}
	 */
	async aceptar(versionId) {
		const session    = await getSession();
		const empresaId  = await getEmpresaId();

		if (!session || !empresaId) {
			return { ok: false, error: 'ERR_SYS_09: Sesión inválida.' };
		}

		showSpinner();
		try {
			// 1. Insertar en terminos_aceptaciones
			const { error: errAcep } = await supabase
				.from('terminos_aceptaciones')
				.insert({
					usuario_id:          session.user.id,
					empresa_id:          empresaId,
					terminos_version_id: versionId,
					aceptado_en:         new Date().toISOString(),
					user_agent:          navigator.userAgent.slice(0, 255),
				});

			if (errAcep) {
				return { ok: false, error: `ERR_SYS_10: No se pudo registrar la aceptación. ${errAcep.message}` };
			}

			// 2. Actualizar terminos_aceptado_en en usuarios
			const { error: errUser } = await supabase
				.from('usuarios')
				.update({ terminos_aceptado_en: new Date().toISOString() })
				.eq('id', session.user.id);

			if (errUser) {
				console.warn('[ATSHEL] Términos registrados pero no se actualizó usuarios:', errUser.message);
			}

			// Invalidar caché del usuario
			_usuarioCache = null;

			return { ok: true, error: null };

		} catch (e) {
			return { ok: false, error: 'ERR_SYS_03: Sin conexión para registrar aceptación.' };
		} finally {
			hideSpinner();
		}
	},

	/**
	 * Verifica si el usuario ya aceptó la versión vigente de los términos.
	 * @returns {Promise<boolean>}
	 */
	async usuarioAcepto() {
		const usuario = await getUsuario();
		if (!usuario) return false;
		// Si terminos_aceptado_en tiene valor, ya aceptó
		return !!usuario.terminos_aceptado_en;
	},
};

// ─────────────────────────────────────────────────────────────
// 8. GUARDS DE NAVEGACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Verifica que hay sesión activa.
 * Si no hay sesión, redirige a login.html.
 * Llamar al inicio de cada pantalla protegida.
 *
 * @returns {Promise<import('@supabase/supabase-js').Session>} La sesión si es válida
 */
export async function requireAuth() {
	const session = await getSession();

	if (!session) {
		window.location.href = '/login.html';
		// throw para detener la ejecución del script que llamó requireAuth
		throw new Error('ERR_SYS_11: Sin sesión activa. Redirigiendo a login.');
	}

	return session;
}

/**
 * Verifica que el usuario tiene uno de los roles requeridos.
 * Si no tiene el rol, redirige a index.html con toast de error.
 *
 * Roles válidos: 'administrador' | 'supervisor' | 'hse'
 *
 * @param {...string} rolesPermitidos
 * @returns {Promise<string>} El rol del usuario si tiene acceso
 */
export async function requireRole(...rolesPermitidos) {
	await requireAuth();

	const rol = await getRol();

	if (!rolesPermitidos.includes(rol)) {
		showToast('No tenés permiso para acceder a esta sección.', 'error');
		setTimeout(() => { window.location.href = '/index.html'; }, 1500);
		throw new Error(`ERR_SYS_12: Rol '${rol}' no autorizado. Se requiere: ${rolesPermitidos.join(' | ')}`);
	}

	return rol;
}

// ─────────────────────────────────────────────────────────────
// 9. HELPER: MANEJO DE ERRORES DE SUPABASE
// ─────────────────────────────────────────────────────────────

/**
 * Maneja errores de Supabase de forma consistente.
 * Loguea, muestra toast y retorna el mensaje limpio.
 *
 * @param {Object} error — objeto error de Supabase
 * @param {string} contexto — descripción de la operación
 * @returns {string} Mensaje de error para el usuario
 */
export function handleSupabaseError(error, contexto = '') {
	if (!error) return '';

	const msg = error.message || 'Error desconocido';
	console.error(`[ATSHEL] ${contexto}:`, error);

	// Errores de idempotencia — el trigger rechazó un duplicado
	if (msg.startsWith('IDEMPOTENT:')) {
		return 'Este registro ya fue guardado anteriormente.';
	}

	// Errores de concurrencia — version no coincide
	if (msg.includes('version') && msg.includes('ERR_HSE')) {
		return 'ERR_HSE_20: Este registro fue modificado por otro usuario. Recargá y volvé a intentar.';
	}

	// Errores de RLS — acceso denegado
	if (error.code === '42501' || msg.includes('row-level security')) {
		return 'ERR_SYS_13: No tenés permiso para realizar esta operación.';
	}

	// Error de red
	if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
		return 'ERR_SYS_03: Sin conexión. La operación se guardará cuando vuelva la señal.';
	}

	return `ERR_SYS_14: ${msg}`;
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-supabase.js
// ─────────────────────────────────────────────────────────────
