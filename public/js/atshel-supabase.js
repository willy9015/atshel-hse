/* ============================================================
   atshel-supabase.js — Autenticación y cliente Supabase
   ATSHEL HSE Manager v1.0

   Expone: window.ATSHEL_AUTH con los métodos que necesita
   el frontend para autenticarse contra Supabase.

   REGLAS:
   - Nunca exponer service_role key
   - Usar solo anon key (VITE_SUPABASE_ANON_KEY en Vercel)
   - JWT claims: rol y empresa_id vienen de app_metadata
   - user_metadata NUNCA se usa para autorización

   DEPENDENCIAS: ninguna (carga primero en el HTML)
   ============================================================ */

(function AtshelSupabase() {
	'use strict';

	/* ── Configuración ──────────────────────────────────
	   Las variables de entorno de Vercel se inyectan en
	   tiempo de build. Como este proyecto es Vanilla JS
	   sin bundler, las URLs se leen desde meta tags
	   inyectados por Vercel o desde window.__ATSHEL_CONFIG
	   definido en el HTML de cada página.

	   INSTRUCCIÓN: en cada HTML, antes de este script,
	   agregar este bloque (Vercel lo puede reemplazar
	   con sus variables de entorno en el HTML base):

	   <script>
	     window.__ATSHEL_CONFIG = {
	       supabaseUrl:  'TU_SUPABASE_URL',
	       supabaseKey:  'TU_SUPABASE_ANON_KEY'
	     };
	   </script>
	   ─────────────────────────────────────────────────── */

	const CFG = window.__ATSHEL_CONFIG || {};
	const SUPABASE_URL = CFG.supabaseUrl || '';
	const SUPABASE_KEY = CFG.supabaseKey || '';

	/* ── Validación temprana ──────────────────────────── */
	if (!SUPABASE_URL || !SUPABASE_KEY) {
		console.error(
			'[ATSHEL] atshel-supabase.js: window.__ATSHEL_CONFIG no está definido. ' +
			'Agregá el bloque de configuración antes de este script en cada HTML.'
		);
	}

	/* ── Headers base para fetch ──────────────────────── */
	function headers(extra) {
		return Object.assign({
			'Content-Type':  'application/json',
			'apikey':        SUPABASE_KEY,
			'Authorization': 'Bearer ' + SUPABASE_KEY
		}, extra || {});
	}

	function authHeaders(token) {
		return {
			'Content-Type':  'application/json',
			'apikey':        SUPABASE_KEY,
			'Authorization': 'Bearer ' + (token || SUPABASE_KEY)
		};
	}

	/* ── Sesión en memoria ────────────────────────────── */
	let _session = null;   /* { access_token, refresh_token, user, expires_at } */

	function saveSession(data) {
		_session = data;
		if (data && data.access_token) {
			try {
				localStorage.setItem('atshel_session', JSON.stringify({
					access_token:  data.access_token,
					refresh_token: data.refresh_token,
					expires_at:    data.expires_at,
					user:          data.user
				}));
			} catch (e) {
				console.warn('[ATSHEL] No se pudo guardar sesión en localStorage:', e);
			}
		} else {
			try { localStorage.removeItem('atshel_session'); } catch (_) {}
		}
	}

	function loadSession() {
		if (_session) return _session;
		try {
			const raw = localStorage.getItem('atshel_session');
			if (!raw) return null;
			const s = JSON.parse(raw);
			/* Verificar que no expiró */
			if (s.expires_at && Date.now() / 1000 > s.expires_at - 60) {
				/* Expirado o a punto de expirar — intentar refresh */
				return null;
			}
			_session = s;
			return s;
		} catch (_) { return null; }
	}

	/* ── API REST de Supabase Auth ────────────────────── */

	/**
	 * Iniciar sesión con email y contraseña.
	 * Retorna { data: { user, session }, error }
	 */
	async function signIn(email, password) {
		try {
			const res = await fetch(
				SUPABASE_URL + '/auth/v1/token?grant_type=password',
				{
					method:  'POST',
					headers: headers(),
					body:    JSON.stringify({ email, password })
				}
			);

			const body = await res.json();

			if (!res.ok) {
				return { data: null, error: { message: body.error_description || body.msg || 'Error de autenticación' } };
			}

			saveSession(body);
			return { data: { user: body.user, session: body }, error: null };

		} catch (err) {
			console.error('[ATSHEL] signIn error:', err);
			return { data: null, error: { message: 'Sin conexión al servidor.' } };
		}
	}

	/**
	 * Cerrar sesión — invalida el token en Supabase y borra local.
	 */
	async function signOut() {
		const s = loadSession();
		try {
			if (s?.access_token) {
				await fetch(SUPABASE_URL + '/auth/v1/logout', {
					method:  'POST',
					headers: authHeaders(s.access_token)
				});
			}
		} catch (err) {
			console.warn('[ATSHEL] signOut fetch error (ignorado):', err);
		} finally {
			saveSession(null);
			_session = null;
			/* Limpiar datos offline */
			_clearLocalData();
		}
	}

	/**
	 * Limpia datos locales al hacer logout.
	 * PowerSync también debe llamarse desde atshel-powersync.js
	 */
	function _clearLocalData() {
		try { localStorage.removeItem('atshel_session'); }    catch (_) {}
		try { localStorage.removeItem('atshel_heartbeat'); }  catch (_) {}
		try { sessionStorage.clear(); }                        catch (_) {}
		/* IndexedDB se limpia desde atshel-powersync.js al desconectar */
	}

	/**
	 * Obtener sesión activa. Intenta refresh si expiró.
	 * Retorna el objeto user o null.
	 */
	async function getSession() {
		const s = loadSession();
		if (s?.user) return s;

		/* Intentar refresh con el token guardado */
		try {
			const raw = localStorage.getItem('atshel_session');
			if (!raw) return null;
			const stored = JSON.parse(raw);
			if (!stored.refresh_token) return null;

			const res = await fetch(
				SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token',
				{
					method:  'POST',
					headers: headers(),
					body:    JSON.stringify({ refresh_token: stored.refresh_token })
				}
			);

			if (!res.ok) {
				saveSession(null);
				return null;
			}

			const body = await res.json();
			saveSession(body);
			return body;

		} catch (err) {
			console.warn('[ATSHEL] getSession refresh error:', err);
			return null;
		}
	}

	/**
	 * Enviar email de recuperación de contraseña.
	 * Retorna { error } o { error: null }
	 */
	async function resetPassword(email) {
		try {
			const res = await fetch(
				SUPABASE_URL + '/auth/v1/recover',
				{
					method:  'POST',
					headers: headers(),
					body:    JSON.stringify({
						email,
						gotrue_meta_security: {}
					})
				}
			);
			/* No importa la respuesta — siempre OK para no revelar emails */
			return { error: null };
		} catch (err) {
			console.error('[ATSHEL] resetPassword error:', err);
			return { error: { message: 'Sin conexión.' } };
		}
	}

	/**
	 * Actualizar contraseña del usuario autenticado.
	 * Retorna { data, error }
	 */
	async function updatePassword(newPassword) {
		const s = loadSession();
		if (!s?.access_token) {
			return { data: null, error: { message: 'Sin sesión activa.' } };
		}

		try {
			const res = await fetch(
				SUPABASE_URL + '/auth/v1/user',
				{
					method:  'PUT',
					headers: authHeaders(s.access_token),
					body:    JSON.stringify({ password: newPassword })
				}
			);

			const body = await res.json();

			if (!res.ok) {
				return { data: null, error: { message: body.msg || 'Error al actualizar contraseña.' } };
			}

			/* Actualizar user en sesión local */
			if (_session) _session.user = body;
			return { data: { user: body }, error: null };

		} catch (err) {
			console.error('[ATSHEL] updatePassword error:', err);
			return { data: null, error: { message: 'Sin conexión.' } };
		}
	}

	/**
	 * Actualizar user_metadata del usuario autenticado.
	 * Usado para guardar terminos_aceptado_en, pin_configurado, etc.
	 * Retorna { data, error }
	 */
	async function updateUserMeta(meta) {
		const s = loadSession();
		if (!s?.access_token) {
			return { data: null, error: { message: 'Sin sesión activa.' } };
		}

		try {
			const res = await fetch(
				SUPABASE_URL + '/auth/v1/user',
				{
					method:  'PUT',
					headers: authHeaders(s.access_token),
					body:    JSON.stringify({ data: meta })
				}
			);

			const body = await res.json();

			if (!res.ok) {
				return { data: null, error: { message: body.msg || 'Error al actualizar datos.' } };
			}

			if (_session) _session.user = body;
			return { data: { user: body }, error: null };

		} catch (err) {
			console.error('[ATSHEL] updateUserMeta error:', err);
			return { data: null, error: { message: 'Sin conexión.' } };
		}
	}

	/**
	 * Llamar a una función RPC de Supabase (POST /rest/v1/rpc/nombre)
	 * Retorna { data, error }
	 */
	async function rpc(fnName, params) {
		const s = loadSession();
		const token = s?.access_token || SUPABASE_KEY;

		try {
			const res = await fetch(
				SUPABASE_URL + '/rest/v1/rpc/' + fnName,
				{
					method:  'POST',
					headers: authHeaders(token),
					body:    JSON.stringify(params || {})
				}
			);

			const body = await res.json();

			if (!res.ok) {
				const msg = body?.message || body?.hint || body?.details || 'Error en RPC ' + fnName;
				return { data: null, error: { message: msg } };
			}

			return { data: body, error: null };

		} catch (err) {
			console.error('[ATSHEL] rpc error (' + fnName + '):', err);
			return { data: null, error: { message: 'Sin conexión.' } };
		}
	}

	/**
	 * Heartbeat — verifica si el usuario sigue activo en el servidor.
	 * Llama a fn_verificar_sesion() cada 60 segundos desde atshel-app.js.
	 * Si devuelve activo=false, hace logout forzado.
	 */
	async function verificarSesionActiva() {
		const { data, error } = await rpc('fn_verificar_sesion', {});

		if (error || !data?.activo) {
			console.warn('[ATSHEL] Sesión inválida — forzando logout:', data?.motivo);
			await signOut();
			window.location.replace('/login.html');
			return false;
		}

		return true;
	}

	/**
	 * Obtener el token de acceso actual (para PowerSync)
	 */
	function getAccessToken() {
		const s = loadSession();
		return s?.access_token || null;
	}

	/**
	 * Verificar si el usuario actual es obrero (tiene oficio, no tiene rol de app)
	 */
	function esObrero() {
		const s = loadSession();
		const user = s?.user;
		if (!user) return false;
		const rol    = user.app_metadata?.rol;
		const oficio = user.app_metadata?.oficio;
		return !rol && !!oficio;
	}

	/**
	 * Obtener rol del usuario actual
	 * Retorna: 'administrador' | 'supervisor' | 'hse' | null
	 */
	function getRol() {
		const s = loadSession();
		return s?.user?.app_metadata?.rol || null;
	}

	/* ── Exponer API pública ──────────────────────────── */
	window.ATSHEL_AUTH = {
		signIn,
		signOut,
		getSession,
		resetPassword,
		updatePassword,
		updateUserMeta,
		rpc,
		verificarSesionActiva,
		getAccessToken,
		esObrero,
		getRol
	};

	/* ── Cargar sesión al iniciar ─────────────────────── */
	loadSession();

	console.info('[ATSHEL] atshel-supabase.js cargado.');

})();
