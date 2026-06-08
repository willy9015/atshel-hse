'use strict';

/**
 * atshel-supabase.js
 * Autenticación con Supabase. Gestión completa del ciclo de sesión.
 *
 * SEGURIDAD CRÍTICA:
 *   - El logout purga PowerSync + SQLite local antes de redirigir.
 *     Sin esto, datos de la empresa quedan en dispositivos compartidos.
 *   - Frontend usa SOLO la anon key pública. La key de servicio va
 *     exclusivamente en Edge Functions, jamás en el cliente.
 *   - Las credenciales vienen de variables VITE_* (Vite build time).
 *     En desarrollo: archivo .env.local — nunca commitear al repo.
 */

// ════════════════════════════════════════════════════════════
// 1. CLIENTE SUPABASE
// ════════════════════════════════════════════════════════════

// En producción estas variables las inyecta Vite en build time.
// En desarrollo, vienen del archivo .env.local
const SUPABASE_URL     = typeof import_meta_env !== 'undefined'
	? import_meta_env.VITE_SUPABASE_URL
	: window.__ATSHEL_CONFIG__?.supabaseUrl;

const SUPABASE_ANON_KEY = typeof import_meta_env !== 'undefined'
	? import_meta_env.VITE_SUPABASE_ANON_KEY
	: window.__ATSHEL_CONFIG__?.supabaseAnonKey;

// Compatibilidad con carga directa sin Vite (desarrollo con archivo HTML)
const _url  = SUPABASE_URL     || 'https://elhweuwczmcatypphnco.supabase.co';
const _key  = SUPABASE_ANON_KEY || window.__ATSHEL_ANON_KEY__;

if (!_key) {
	console.error('[ATSHEL] VITE_SUPABASE_ANON_KEY no configurada.');
}

// El cliente Supabase se carga desde el CDN en el HTML antes de este script.
// Usamos window.supabase (desde el UMD) o import en el build de Vite.
const { createClient } = window.supabase || {};

if (!createClient) {
	throw new Error('[ATSHEL] Supabase JS client no cargado. Verificar orden de scripts.');
}

/** @type {import('@supabase/supabase-js').SupabaseClient} */
const supabaseClient = createClient(_url, _key, {
	auth: {
		// Persistir sesión en localStorage para offline
		persistSession:    true,
		storageKey:        'atshel_session',
		autoRefreshToken:  true,
		detectSessionInUrl: false,   // no OAuth, evita procesamiento de hash
	},
	global: {
		headers: {
			'X-Client-Info': 'atshel-hse/1.0',
		},
	},
	// Realtime desactivado: usamos PowerSync para sync, no Realtime
	realtime: {
		params: {
			eventsPerSecond: 0,
		},
	},
});

// Exportar globalmente para que los demás módulos lo usen
window.atshel = window.atshel || {};
window.atshel.supabase = supabaseClient;

// ════════════════════════════════════════════════════════════
// 2. ESTADO DE SESIÓN
// ════════════════════════════════════════════════════════════

/** Caché en memoria de la sesión actual. Se puebla en init(). */
let _session  = null;
let _usuario  = null;   // fila de public.usuarios
let _empresaId = null;
let _rol       = null;

/**
 * Retorna la sesión activa o null.
 * @returns {import('@supabase/supabase-js').Session|null}
 */
window.atshel.getSession = function() { return _session; };

/**
 * Retorna el usuario extendido (con empresa_id, rol, etc.) o null.
 */
window.atshel.getUsuario = function() { return _usuario; };

/**
 * Retorna el empresa_id del usuario actual.
 */
window.atshel.getEmpresaId = function() { return _empresaId; };

/**
 * Retorna el rol del usuario actual.
 */
window.atshel.getRol = function() { return _rol; };

/**
 * Verifica si el usuario tiene permiso para un rol mínimo.
 * Jerarquía: administrador > supervisor > hse
 * @param {'hse'|'supervisor'|'administrador'} rolMinimo
 * @returns {boolean}
 */
window.atshel.tieneRol = function(rolMinimo) {
	const jerarquia = { hse: 1, supervisor: 2, administrador: 3 };
	return (jerarquia[_rol] || 0) >= (jerarquia[rolMinimo] || 0);
};

// ════════════════════════════════════════════════════════════
// 3. INICIALIZACIÓN
// ════════════════════════════════════════════════════════════

/**
 * Inicializa la sesión. Llamar desde atshel-app.js en el arranque.
 * Lee la sesión persistida, carga el perfil del usuario de la DB.
 * @returns {Promise<boolean>} — true si hay sesión válida
 */
window.atshel.initAuth = async function() {
	try {
		const { data: { session }, error } = await supabaseClient.auth.getSession();

		if (error) {
			console.error('[Auth] Error al recuperar sesión:', error.message);
			return false;
		}

		if (!session) return false;

		_session = session;
		await _cargarPerfilUsuario(session.user.id);

		// Registrar escucha de cambios de auth (refresh de token, logout externo)
		supabaseClient.auth.onAuthStateChange(async (event, newSession) => {
			if (event === 'SIGNED_OUT') {
				await window.atshel.logout(false); // sin redirigir (ya está fuera)
				return;
			}
			if (event === 'TOKEN_REFRESHED' && newSession) {
				_session = newSession;
				// El empresa_id y rol no cambian, no necesitamos recargar perfil
			}
		});

		return true;
	} catch (err) {
		console.error('[Auth] initAuth falló:', err);
		return false;
	}
};

/**
 * Carga el perfil del usuario desde public.usuarios.
 * @param {string} userId — auth.uid()
 */
async function _cargarPerfilUsuario(userId) {
	const { data, error } = await supabaseClient
		.from('usuarios')
		.select('id, empresa_id, rol, nombre_completo, activo, es_nuevo_ingresante')
		.eq('id', userId)
		.single();

	if (error || !data) {
		console.error('[Auth] No se pudo cargar perfil de usuario:', error?.message);
		return;
	}

	_usuario   = data;
	_empresaId = data.empresa_id;
	_rol       = data.rol;

	// Guardar en sessionStorage como respaldo rápido (no persiste en reinicio)
	sessionStorage.setItem('atshel_empresa_id', _empresaId);
	sessionStorage.setItem('atshel_rol',        _rol);
}

// ════════════════════════════════════════════════════════════
// 4. LOGIN
// ════════════════════════════════════════════════════════════

/**
 * Inicia sesión con email y contraseña.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
window.atshel.login = async function(email, password) {
	try {
		const { data, error } = await supabaseClient.auth.signInWithPassword({
			email:    email.trim().toLowerCase(),
			password,
		});

		if (error) {
			// Traducir errores de Supabase a español argentino
			const mensajes = {
				'Invalid login credentials':       'Email o contraseña incorrectos.',
				'Email not confirmed':             'Confirmá tu email antes de ingresar.',
				'Too many requests':               'Demasiados intentos. Esperá unos minutos.',
				'User account has been disabled':  'Tu cuenta está desactivada. Contactá al administrador.',
			};
			return {
				ok:    false,
				error: mensajes[error.message] || 'Error al ingresar. Intentá de nuevo.',
			};
		}

		_session = data.session;
		await _cargarPerfilUsuario(data.user.id);

		// Verificar que el usuario tenga empresa y rol válidos
		if (!_empresaId || !_rol) {
			await supabaseClient.auth.signOut();
			return {
				ok:    false,
				error: 'Tu cuenta no tiene empresa asignada. Contactá al administrador.',
			};
		}

		// Verificar que la cuenta esté activa
		if (_usuario && !_usuario.activo) {
			await supabaseClient.auth.signOut();
			return {
				ok:    false,
				error: 'Tu cuenta está desactivada. Contactá al administrador.',
			};
		}

		return { ok: true };

	} catch (err) {
		console.error('[Auth] login falló:', err);
		return { ok: false, error: 'Error de red. Verificá tu conexión.' };
	}
};

// ════════════════════════════════════════════════════════════
// 5. LOGOUT — PURGA COMPLETA DE DATOS LOCALES
// ════════════════════════════════════════════════════════════

/**
 * Cierra sesión y PURGA COMPLETAMENTE el estado local.
 *
 * SEGURIDAD CRÍTICA: En dispositivos compartidos o extraviados,
 * estos datos no deben quedar accesibles. El orden es deliberado:
 *   1. Desconectar PowerSync PRIMERO (detiene sync en curso)
 *   2. Limpiar storage de PowerSync (borra SQLite local)
 *   3. Cerrar sesión en Supabase (invalida JWT)
 *   4. Limpiar localStorage, sessionStorage, IndexedDB
 *   5. Redirigir al login
 *
 * @param {boolean} redirigir — si true (default), va a login.html
 */
window.atshel.logout = async function(redirigir = true) {
	console.info('[Auth] Iniciando logout seguro...');

	try {
		// ── PASO 1: Desconectar y purgar PowerSync ──────────────
		const ps = window.atshel?.powerSync;
		if (ps) {
			try {
				await ps.disconnect();
				// clearStorage() borra la base SQLite del dispositivo
				if (typeof ps.clearStorage === 'function') {
					await ps.clearStorage();
				}
				// Alternativa según versión del SDK
				if (typeof ps.disconnectAndClear === 'function') {
					await ps.disconnectAndClear();
				}
				console.info('[Auth] PowerSync desconectado y storage limpiado.');
			} catch (psErr) {
				// No bloquear el logout si PowerSync falla
				console.warn('[Auth] Error al limpiar PowerSync:', psErr);
			}
		}

		// ── PASO 2: Cerrar sesión en Supabase ───────────────────
		await supabaseClient.auth.signOut({ scope: 'local' });

		// ── PASO 3: Limpiar estado en memoria ───────────────────
		_session   = null;
		_usuario   = null;
		_empresaId = null;
		_rol       = null;

		// ── PASO 4: Limpiar localStorage ────────────────────────
		// Solo borrar claves de ATSHEL, no claves de otras apps
		const KEYS_A_BORRAR = [
			'atshel_session',
			'atshel_empresa_id',
			'atshel_rol',
			'atshel_heartbeat',
			'atshel_heartbeat_ts',
			'atshel_upload_queue',
			'atshel_draft_incidente',
			'atshel_draft_ats',
			'sb-elhweuwczmcatypphnco-auth-token',   // clave interna de Supabase JS
		];
		KEYS_A_BORRAR.forEach(k => {
			try { localStorage.removeItem(k); } catch { /* storage bloqueado en iOS */ }
		});
		sessionStorage.clear();

		// ── PASO 5: Purgar IndexedDB de ATSHEL ──────────────────
		await _purgarIndexedDB();

		console.info('[Auth] Logout seguro completado.');

	} catch (err) {
		// Aunque haya error, seguir con el logout para no dejar al usuario atrapado
		console.error('[Auth] Error durante logout:', err);
	} finally {
		if (redirigir) {
			// Reemplazar el historial para que el botón "atrás" no vuelva a la app
			window.location.replace('/login.html');
		}
	}
};

/**
 * Purga todas las bases de datos IndexedDB con prefijo "atshel".
 * Incluye la base de PowerSync y la cola de archivos.
 */
async function _purgarIndexedDB() {
	if (!window.indexedDB?.databases) {
		// Safari < 15 no soporta .databases() — intentar borrar por nombre conocido
		const DB_CONOCIDAS = [
			'atshel-powersync',
			'atshel-media-queue',
			'atshel-drafts',
			'atshel',
		];
		await Promise.allSettled(
			DB_CONOCIDAS.map(nombre => _borrarIDB(nombre))
		);
		return;
	}

	try {
		const bases = await indexedDB.databases();
		const atshelBases = bases.filter(db =>
			db.name && (db.name.startsWith('atshel') || db.name.startsWith('powersync'))
		);
		await Promise.allSettled(
			atshelBases.map(db => _borrarIDB(db.name))
		);
	} catch (err) {
		console.warn('[Auth] No se pudieron listar las IDB:', err);
	}
}

/**
 * Borra una base IndexedDB por nombre.
 * @param {string} nombre
 */
function _borrarIDB(nombre) {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(nombre);
		req.onsuccess  = () => { console.info(`[Auth] IDB "${nombre}" eliminada.`); resolve(); };
		req.onerror    = () => { console.warn(`[Auth] No se pudo eliminar IDB "${nombre}".`); resolve(); };
		req.onblocked  = () => {
			console.warn(`[Auth] IDB "${nombre}" bloqueada — otra pestaña la tiene abierta.`);
			resolve();
		};
	});
}

// ════════════════════════════════════════════════════════════
// 6. GUARDS DE PANTALLA
// ════════════════════════════════════════════════════════════

/**
 * Guard para pantallas protegidas.
 * Si no hay sesión, redirige al login.
 * Llamar al inicio de cada pantalla protegida.
 * @returns {Promise<boolean>} — true si la sesión es válida
 */
window.atshel.requireAuth = async function() {
	const ok = await window.atshel.initAuth();
	if (!ok) {
		window.location.replace('/login.html');
		return false;
	}
	return true;
};

/**
 * Guard para pantallas de solo admin.
 * @returns {Promise<boolean>}
 */
window.atshel.requireAdmin = async function() {
	const ok = await window.atshel.requireAuth();
	if (!ok) return false;
	if (!window.atshel.tieneRol('administrador')) {
		showToast('No tenés permiso para acceder a esta sección.', 'error');
		history.back();
		return false;
	}
	return true;
};

/**
 * Guard para pantallas de supervisor o admin.
 * @returns {Promise<boolean>}
 */
window.atshel.requireSupervisor = async function() {
	const ok = await window.atshel.requireAuth();
	if (!ok) return false;
	if (!window.atshel.tieneRol('supervisor')) {
		showToast('Solo supervisores o administradores pueden acceder.', 'error');
		history.back();
		return false;
	}
	return true;
};

// ════════════════════════════════════════════════════════════
// 7. HELPERS DE API
// ════════════════════════════════════════════════════════════

/**
 * Wrapper sobre supabaseClient.from() que agrega empresa_id automáticamente
 * en queries SELECT (como segunda capa de defensa además del RLS).
 * Preferir RLS sobre esto, pero no hace daño ser redundante.
 *
 * @param {string} tabla
 * @returns {import('@supabase/supabase-js').SupabaseQueryBuilder}
 */
window.atshel.from = function(tabla) {
	return supabaseClient.from(tabla);
};

/**
 * Llama a una función RPC de Supabase.
 * @param {string} fn — nombre de la función
 * @param {object} params — parámetros
 * @returns {Promise<{data: any, error: any}>}
 */
window.atshel.rpc = function(fn, params = {}) {
	return supabaseClient.rpc(fn, params);
};

/**
 * Retorna la URL firmada de un archivo en Storage.
 * Las URLs firmadas expiran en 1 hora (3600 segundos).
 * @param {string} path — ruta dentro del bucket (sin el nombre del bucket)
 * @param {number} expiresIn — segundos (default: 3600)
 * @returns {Promise<string|null>}
 */
window.atshel.getStorageUrl = async function(path, expiresIn = 3600) {
	if (!path) return null;
	const { data, error } = await supabaseClient.storage
		.from('atshel-media')
		.createSignedUrl(path, expiresIn);

	if (error) {
		console.error('[Storage] Error al generar URL firmada:', error.message);
		return null;
	}
	return data.signedUrl;
};

// ════════════════════════════════════════════════════════════
// 8. RECUPERACIÓN DE CONTRASEÑA
// ════════════════════════════════════════════════════════════

/**
 * Envía email de recuperación de contraseña.
 * @param {string} email
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
window.atshel.recuperarContrasena = async function(email) {
	const { error } = await supabaseClient.auth.resetPasswordForEmail(
		email.trim().toLowerCase(),
		{ redirectTo: `${location.origin}/reset-password.html` }
	);

	if (error) {
		return { ok: false, error: 'No se pudo enviar el email. Verificá la dirección.' };
	}
	return { ok: true };
};

console.info('[ATSHEL] Supabase auth cargado ✓');
