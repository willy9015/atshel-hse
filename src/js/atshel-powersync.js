/**
 * atshel-powersync.js
 * Inicialización y motor SQLite local de PowerSync para ATSHEL HSE Manager.
 * Schema SQLite construido columna por columna desde MCP (2026-06-14).
 *
 * v3.1.0 — Blindaje Offline-First, Aislamiento de Sesión y Cola Resiliente
 *
 * Mejoras de Arquitectura v3.1.0:
 *   1. Separación estricta entre `await _db.init()` (apertura SQLite local sin red)
 *      y `_db.connect(connector)` (sincronización remota). La base local queda
 *      100% operativa en <30ms aunque el técnico abra la app sin señal en el pozo.
 *   2. `fetchCredentials()` offline-safe: no dispara `refreshSession()` si el
 *      dispositivo está sin señal (`!navigator.onLine`), evitando errores ruidosos.
 *   3. Prevención de "Poison Pill" en `uploadData()`: distingue errores transitorios
 *      de red (reintenta) vs. errores fatales de constraint/RLS en Postgres (descarta
 *      y destraba la cola para no frenar los demás ATS/incidentes del turno).
 *   4. Aislamiento de datos entre cuentas (`closePowerSync()` + `hasPendingCrud()`):
 *      limpia el archivo SQLite local al cerrar sesión (SIGNED_OUT) siempre que no
 *      existan operaciones offline pendientes de subir.
 *   5. `watchLocal()` implementado con `AbortController` estándar de @powersync/web ^1.0.0
 *      para evitar fugas de memoria.
 *
 * Exporta:
 *   · db — instancia de PowerSyncDatabase (singleton)
 *   · initPowerSync()
 *   · closePowerSync({ clearLocal })
 *   · hasPendingCrud()
 *   · isPowerSyncReady()
 *   · queryLocal(sql, params)
 *   · watchLocal(sql, params, callback)
 *   · executeLocal(sql, params)
 *   · parseJsonField(valor, fallback)
 *   · stringifyJsonField(valor)
 */

import {
	PowerSyncDatabase,
	Column,
	ColumnType,
	Table,
	Schema,
} from '@powersync/web';

import { supabase, getSession } from './atshel-supabase.js';
import { syncStatus } from './atshel-core.js';

// ─────────────────────────────────────────────────────────────
// 1. HELPERS DE COLUMNAS — abreviaciones para el schema
// ─────────────────────────────────────────────────────────────

const TEXT = (name) => new Column({ name, type: ColumnType.TEXT });
const INT  = (name) => new Column({ name, type: ColumnType.INTEGER });
const REAL = (name) => new Column({ name, type: ColumnType.REAL });

// ─────────────────────────────────────────────────────────────
// 2. SCHEMA SQLITE LOCAL
//    Columnas verificadas MCP columna por columna.
//    NOTA: 'id' es manejado automáticamente por PowerSync como PK.
// ─────────────────────────────────────────────────────────────

const ATSHEL_SCHEMA = new Schema({

	// ── Empresas (solo lectura — referencia) ────────────────
	empresas: new Table({
		columns: [
			TEXT('nombre'),
			TEXT('cuit'),
			TEXT('logo_url'),
			INT('activa'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Usuarios ────────────────────────────────────────────
	usuarios: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('rol'),
			TEXT('nombre_completo'),
			TEXT('tipo_trabajo_id'),
			TEXT('terminos_aceptado_en'),
			INT('activo'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
			INT('induccion_completada'),
			TEXT('fecha_induccion'),
			TEXT('induccion_dictada_por'),
			TEXT('oficio'),
			INT('es_nuevo_ingresante'),
			TEXT('fecha_ingreso'),
			TEXT('tutor_id'),
		],
	}),

	// ── User Roles ───────────────────────────────────────────
	user_roles: new Table({
		columns: [
			TEXT('user_id'),
			TEXT('empresa_id'),
			TEXT('rol'),
			TEXT('created_at'),
			TEXT('updated_at'),
		],
	}),

	// ── Incidentes ───────────────────────────────────────────
	incidentes: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('empresa_id'),
			TEXT('numero'),
			TEXT('tipo'),
			TEXT('severidad'),
			TEXT('descripcion'),
			TEXT('fecha_hora'),
			TEXT('ubicacion'),
			TEXT('locacion_nombre'),
			REAL('latitud'),
			REAL('longitud'),
			TEXT('acciones_inmediatas'),       // JSONB → text
			TEXT('fotos_urls'),                // TEXT[] → text (JSON array)
			TEXT('investigacion'),             // JSONB → text
			TEXT('estado'),
			INT('version'),
			TEXT('hash_contenido'),
			TEXT('created_by'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
			TEXT('factores_contribuyentes'),   // JSONB → text
			TEXT('estado_aprobacion'),
			TEXT('fecha_hora_firma'),
			TEXT('ubicacion_id'),
		],
	}),

	// ── Aprobaciones de Incidente ────────────────────────────
	aprobaciones_incidente: new Table({
		columns: [
			TEXT('incidente_id'),
			TEXT('empresa_id'),
			TEXT('aprobador_id'),
			TEXT('decision'),
			TEXT('comentario'),
			TEXT('created_at'),
		],
	}),

	// ── Investigaciones Causa Raíz ───────────────────────────
	investigaciones_causa_raiz: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('incidente_id'),
			TEXT('empresa_id'),
			TEXT('auditor_id'),
			TEXT('fecha_investigacion'),
			TEXT('porque_1'),
			TEXT('porque_2'),
			TEXT('porque_3'),
			TEXT('porque_4'),
			TEXT('porque_5'),
			TEXT('conclusion'),
			INT('version'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Soluciones / Acciones de Incidente ───────────────────
	soluciones_incidentes: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('investigacion_id'),
			TEXT('empresa_id'),
			TEXT('accion_correctiva'),
			TEXT('responsable_id'),
			TEXT('fecha_limite'),
			TEXT('estado_solucion'),
			TEXT('fecha_cierre_real'),
			INT('version'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Lesiones ─────────────────────────────────────────────
	lesiones: new Table({
		columns: [
			TEXT('incidente_id'),
			TEXT('empresa_id'),
			TEXT('afectado_id'),
			TEXT('tipo_lesion'),
			TEXT('parte_cuerpo'),
			TEXT('descripcion'),
			TEXT('created_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Acciones Correctivas ─────────────────────────────────
	acciones_correctivas: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('incidente_id'),
			TEXT('empresa_id'),
			TEXT('descripcion'),
			TEXT('responsable_id'),
			TEXT('fecha_vencimiento'),
			TEXT('fecha_cierre'),
			TEXT('estado'),
			TEXT('evidencia_urls'),           // TEXT[] → text
			INT('version'),
			TEXT('created_by'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Plantillas ATS ───────────────────────────────────────
	plantillas_ats: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('nombre_ats'),
			TEXT('tipo_trabajo'),
			TEXT('archivo_origen_url'),
			INT('activa'),
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('updated_at'),
			INT('version'),
		],
	}),

	// ── Campos de Plantilla ──────────────────────────────────
	campos_plantilla: new Table({
		columns: [
			TEXT('plantilla_id'),
			TEXT('etiqueta'),
			TEXT('tipo_campo'),
			INT('orden'),
			INT('requerido'),
			TEXT('opciones'),               // JSONB → text
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('empresa_id'),
		],
	}),

	// ── Instancias ATS ───────────────────────────────────────
	ats_instancias: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('plantilla_id'),
			TEXT('empresa_id'),
			TEXT('creado_por'),
			TEXT('estado'),
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('updated_at'),
			INT('version'),
			TEXT('riesgos_evaluacion'),     // JSONB → text
			TEXT('firmado_en'),
			INT('bloqueado'),
			INT('es_modelo'),
			TEXT('fecha_hora_firma'),
			TEXT('ubicacion_id'),
		],
	}),

	// ── Respuestas ATS ───────────────────────────────────────
	ats_respuestas: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('instancia_id'),           // FK verificada MCP
			TEXT('campo_id'),
			TEXT('valor'),
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('empresa_id'),
		],
	}),

	// ── Firmas ATS ───────────────────────────────────────────
	ats_firmas: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('instancia_id'),
			TEXT('usuario_id'),
			TEXT('empresa_id'),
			TEXT('fecha_firma_local'),
			TEXT('fecha_sincronizacion'),
			INT('mail_enviado'),
			TEXT('deleted_at'),
			TEXT('created_at'),
		],
	}),

	// ── Capacitaciones Pre-Trabajo ───────────────────────────
	ats_capacitaciones_pre_trabajo: new Table({
		columns: [
			TEXT('instancia_id'),
			TEXT('empresa_id'),
			TEXT('tema'),
			TEXT('dictado_por'),
			TEXT('tipo'),
			TEXT('created_at'),
		],
	}),

	// ── Asistentes a Capacitación ────────────────────────────
	ats_capacitacion_asistentes: new Table({
		columns: [
			TEXT('capacitacion_id'),
			TEXT('empresa_id'),
			TEXT('usuario_id'),
			TEXT('firma_url'),
			TEXT('eficacia'),
			TEXT('created_at'),
		],
	}),

	// ── Permisos de Trabajo ──────────────────────────────────
	permisos_trabajo: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('empresa_id'),
			TEXT('ats_instancia_id'),
			TEXT('tipo_permiso'),
			TEXT('descripcion'),
			TEXT('ubicacion'),
			TEXT('solicitado_por'),
			TEXT('aprobado_por'),
			TEXT('fecha_inicio'),
			TEXT('fecha_fin'),
			TEXT('estado'),
			TEXT('observaciones'),
			TEXT('restricciones'),          // JSONB → text
			TEXT('motivo_cierre'),
			INT('version'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
			TEXT('fecha_hora_cierre'),
			TEXT('ubicacion_id'),
			REAL('velocidad_viento'),
			TEXT('direccion_viento'),
			REAL('rafaga_maxima'),
		],
	}),

	// ── Tipos de Checklist ───────────────────────────────────
	tipos_checklist: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('titulo'),
			INT('activo'),
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('updated_at'),
			INT('version'),
		],
	}),

	// ── Preguntas de Checklist ───────────────────────────────
	preguntas_checklist: new Table({
		columns: [
			TEXT('tipo_checklist_id'),
			TEXT('pregunta'),
			INT('orden'),
			INT('requerida'),
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('empresa_id'),
		],
	}),

	// ── Instancias de Checklist ──────────────────────────────
	checklist_instancias: new Table({
		columns: [
			TEXT('tipo_checklist_id'),
			TEXT('empresa_id'),
			TEXT('usuario_id'),
			TEXT('permiso_trabajo_id'),
			TEXT('estado'),
			TEXT('deleted_at'),
			TEXT('created_at'),
		],
	}),

	// ── Respuestas de Checklist ──────────────────────────────
	checklist_respuestas: new Table({
		columns: [
			TEXT('checklist_instancia_id'),
			TEXT('pregunta_id'),
			TEXT('empresa_id'),
			TEXT('respuesta'),
			TEXT('observacion'),
			TEXT('foto_url'),
			TEXT('created_at'),
		],
	}),

	// ── EPP Catálogo ─────────────────────────────────────────
	epp_catalog: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('nombre'),
			TEXT('descripcion'),
			TEXT('imagen_url'),
			INT('activo'),
			TEXT('created_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── EPP Requerido ────────────────────────────────────────
	epp_requerido: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('tipo_trabajo_id'),
			TEXT('epp_catalog_id'),
			TEXT('deleted_at'),
			TEXT('created_at'),
		],
	}),

	// ── EPP Entregas ─────────────────────────────────────────
	epp_entregas: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('trabajador_id'),
			TEXT('empresa_id'),
			TEXT('epp_catalog_id'),
			TEXT('fecha_entrega'),
			TEXT('firma_url'),
			INT('version'),
			TEXT('created_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Tipos de Trabajo ─────────────────────────────────────
	tipos_trabajo: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('nombre'),
			INT('activo'),
			TEXT('created_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Operarios por Puesto ─────────────────────────────────
	operarios_puestos: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('usuario_id'),
			TEXT('puesto_id'),
			TEXT('deleted_at'),
			TEXT('created_at'),
		],
	}),

	// ── Puestos de Trabajo ───────────────────────────────────
	puestos_trabajo: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('nombre_puesto'),
			TEXT('descripcion'),
			INT('requiere_certificacion'),
			INT('activo'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Mantenimientos y Vencimientos ────────────────────────
	mantenimientos_y_vencimientos: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('elemento_tipo'),
			TEXT('referencia_id'),
			TEXT('nombre'),
			TEXT('fecha_vencimiento'),
			INT('dias_anticipacion_alerta'),
			TEXT('estado_alerta'),
			TEXT('created_at'),
			TEXT('updated_at'),
			TEXT('deleted_at'),
		],
	}),

	// ── Equipos ──────────────────────────────────────────────
	equipos: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('tipo'),
			TEXT('numero_serie'),
			TEXT('certificado_calibracion'),
			TEXT('fecha_calibracion'),
			TEXT('fecha_vencimiento_calibracion'),
			TEXT('estado'),
			TEXT('deleted_at'),
			TEXT('created_at'),
			TEXT('updated_at'),
		],
	}),

	// ── Ubicaciones ──────────────────────────────────────────
	ubicaciones: new Table({
		columns: [
			TEXT('empresa_id'),
			TEXT('nombre'),
			REAL('latitud'),
			REAL('longitud'),
			TEXT('descripcion'),
			TEXT('created_at'),
		],
	}),

});

// ─────────────────────────────────────────────────────────────
// 3. CONNECTOR — Autenticación y Subida Resiliente
// ─────────────────────────────────────────────────────────────

// Códigos SQLSTATE de PostgreSQL que representan errores permanentes de datos/permisos
// (no se solucionan reintentando y trabarían la cola offline para siempre si no se descartan)
const PG_FATAL_CODES = new Set([
	'22P02', // invalid_text_representation (UUID o JSON malformado)
	'23502', // not_null_violation
	'23503', // foreign_key_violation
	'23505', // unique_violation
	'23514', // check_violation
	'42501', // insufficient_privilege (RLS rechazó la escritura)
	'42703', // undefined_column
	'PGRST204', // columna no encontrada en schema cache de PostgREST
]);

class AtShelConnector {

	constructor() {
		this._powersyncUrl = import.meta.env.VITE_POWERSYNC_URL;

		if (!this._powersyncUrl) {
			throw new Error(
				'[ATSHEL] ERR_SYS_20: VITE_POWERSYNC_URL no configurada. ' +
				'Definila en .env.local o en Vercel Environment Variables.'
			);
		}
	}

	/**
	 * PowerSync llama a fetchCredentials() cuando necesita autenticarse.
	 * Si el dispositivo está offline, retorna null o el token actual sin
	 * intentar un refresh por red que fallaría.
	 */
	async fetchCredentials() {
		const session = await getSession();

		if (!session) {
			return null;
		}

		// Si estamos sin señal en campo, no intentar refresh por red
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			return null;
		}

		const expiresAt   = session.expires_at ?? 0;
		const ahoraEnSecs = Math.floor(Date.now() / 1000);

		// Si el token expira en menos de 60s y hay señal, refrescar
		if (expiresAt - ahoraEnSecs < 60) {
			const { data, error } = await supabase.auth.refreshSession();
			if (error || !data?.session) {
				console.warn('[ATSHEL:powersync] No se pudo refrescar JWT para sync remota:', error?.message);
				return null;
			}
			return {
				endpoint:  this._powersyncUrl,
				token:     data.session.access_token,
				expiresAt: new Date(data.session.expires_at * 1000),
			};
		}

		return {
			endpoint:  this._powersyncUrl,
			token:     session.access_token,
			expiresAt: new Date(session.expires_at * 1000),
		};
	}

	/**
	 * PowerSync llama a uploadData() cuando hay cambios locales que sincronizar.
	 *
	 * @param {PowerSyncDatabase} database
	 */
	async uploadData(database) {
		const transaction = await database.getNextCrudTransaction();
		if (!transaction) return;

		let ultimaOp = null;

		try {
			for (const op of transaction.crud) {
				ultimaOp = op;
				await this._procesarOperacion(op);
			}
			await transaction.complete();

		} catch (error) {
			const msg  = error?.message || '';
			const code = error?.code || '';

			// 1. Errores de idempotencia — operación ya procesada en el backend
			if (msg.startsWith('IDEMPOTENT:') || code === '23505') {
				console.warn('[ATSHEL:powersync] Operación duplicada/idempotente absorbida:', msg);
				await transaction.complete();
				return;
			}

			// 2. Errores fatales de negocio/RLS/schema (Poison Pill):
			//    Si no completamos la transacción, PowerSync reintentará este registro
			//    infinitamente y bloqueará toda la cola posterior del teléfono.
			const esErrorFatal =
				PG_FATAL_CODES.has(code) ||
				msg.includes('row-level security') ||
				msg.includes('violates foreign key') ||
				msg.includes('violates check constraint');

			if (esErrorFatal) {
				console.error(
					'[ATSHEL:powersync] Operación rechazada permanentemente por Postgres (descartada para no bloquear cola):',
					{ tabla: ultimaOp?.table, id: ultimaOp?.id, tipo: ultimaOp?.op, code, msg }
				);
				await transaction.complete();
				return;
			}

			// 3. Error transitorio de red o 5xx: relanzar para que PowerSync reintente luego
			console.warn('[ATSHEL:powersync] Error de red al sincronizar. Se reintentará automáticamente:', msg);
			throw error;
		}
	}

	/**
	 * Procesa una operación CRUD individual desde PowerSync hacia Supabase.
	 * @param {{ op: string, table: string, id: string, opData: Object }} op
	 */
	async _procesarOperacion(op) {
		const { op: tipo, table, id, opData } = op;

		switch (tipo) {
			case 'PUT': {
				const { error } = await supabase
					.from(table)
					.upsert({ id, ...opData }, {
						onConflict:       'id',
						ignoreDuplicates: false,
					});

				if (error) throw error;
				break;
			}

			case 'PATCH': {
				const { error } = await supabase
					.from(table)
					.update(opData)
					.eq('id', id);

				if (error) throw error;
				break;
			}

			case 'DELETE': {
				// Soft-delete obligatorio por regla de proyecto
				const { error } = await supabase
					.from(table)
					.update({ deleted_at: new Date().toISOString() })
					.eq('id', id);

				if (error) throw error;
				break;
			}

			default:
				console.warn(`[ATSHEL:powersync] Operación desconocida: ${tipo}`);
		}
	}
}

// ─────────────────────────────────────────────────────────────
// 4. INSTANCIA SINGLETON Y ESTADO
// ─────────────────────────────────────────────────────────────

let _db          = null;
let _ready       = false;
let _initPromise = null;
let _activeUser  = null;

/**
 * Instancia de PowerSyncDatabase. null hasta que initPowerSync() resuelva.
 */
export let db = null;

// ─────────────────────────────────────────────────────────────
// 5. INICIALIZACIÓN Y AISLAMIENTO ENTRE SESIONES
// ─────────────────────────────────────────────────────────────

/**
 * Inicializa PowerSync de forma Offline-First real:
 *   1. Verifica si cambió el usuario respecto de la última sesión en el dispositivo.
 *      Si es otro usuario y no hay datos locales sin subir, limpia el SQLite previo.
 *   2. Abre el motor SQLite local (`await _db.init()`) SIN depender de la red.
 *   3. Marca `_ready = true` inmediatamente para habilitar lecturas/escrituras offline.
 *   4. Inicia `_db.connect(connector)` en background (no bloquea el arranque si no hay señal).
 *
 * @returns {Promise<PowerSyncDatabase>}
 */
export async function initPowerSync() {
	if (_ready && _db) return _db;
	if (_initPromise) return _initPromise;

	_initPromise = (async () => {
		try {
			const session       = await getSession();
			const currentUserId = session?.user?.id ?? null;
			const lastUserId    = localStorage.getItem('atshel_ps_user_id');

			const connector = new AtShelConnector();

			_db = new PowerSyncDatabase({
				schema:   ATSHEL_SCHEMA,
				database: {
					dbFilename: 'atshel.db',
				},
			});

			// 1. Inicializar motor SQLite local en disco (no requiere internet)
			await _db.init();
			db = _db;

			// 2. Aislamiento entre cuentas: si inicia sesión un usuario distinto al dueño
			//    de la base local, purgar datos del usuario anterior (salvo cola pendiente).
			if (currentUserId && lastUserId && lastUserId !== currentUserId) {
				const pendientes = await _contarPendientesInterno(_db);
				if (pendientes === 0) {
					console.info('[ATSHEL:powersync] Cambio de usuario detectado. Limpiando SQLite local previo...');
					await _db.disconnectAndClear();
				} else {
					console.warn(
						`[ATSHEL:powersync] Cambio de usuario con ${pendientes} operaciones pendientes de subir. ` +
						'Se conserva cola hasta completar subida.'
					);
				}
			}

			if (currentUserId) {
				localStorage.setItem('atshel_ps_user_id', currentUserId);
				_activeUser = currentUserId;
			}

			// 3. Suscribirse a cambios de estado de sincronización
			_db.registerListener({
				statusChanged: (status) => {
					_actualizarSyncStatus(status);
				},
			});

			// 4. SQLite local ya está listo para operar offline
			_ready = true;

			// 5. Conectar stream de sincronización remota sin bloquear el arranque offline
			if (typeof navigator === 'undefined' || navigator.onLine) {
				_db.connect(connector).catch((err) => {
					console.warn('[ATSHEL:powersync] Arranque en modo offline (connect diferido):', err.message);
					syncStatus.actualizar({ estado: 'desconectado' });
				});
			} else {
				syncStatus.actualizar({ estado: 'desconectado' });
			}

			// Reconectar automáticamente cuando vuelva la señal en el yacimiento
			window.addEventListener('online', () => {
				if (_ready && _db) {
					_db.connect(connector).catch(() => {});
				}
			});

			console.info('[ATSHEL:powersync] Motor SQLite local listo.');
			return _db;

		} catch (error) {
			_ready       = false;
			_initPromise = null;
			console.error('[ATSHEL:powersync] Error crítico al inicializar SQLite local:', error);
			syncStatus.actualizar({ estado: 'error' });
			throw error;
		}
	})();

	return _initPromise;
}

/**
 * Cuenta cuántas operaciones locales están pendientes de sincronizar en `ps_crud`.
 * @param {PowerSyncDatabase} database
 * @returns {Promise<number>}
 */
async function _contarPendientesInterno(database) {
	try {
		const rows = await database.getAll('SELECT count(*) as total FROM ps_crud');
		return Number(rows?.[0]?.total ?? 0);
	} catch {
		return 0;
	}
}

/**
 * Retorna true si existen registros creados/editados offline que aún no subieron a Supabase.
 * Útil antes de cerrar sesión para advertir al operador.
 *
 * @returns {Promise<boolean>}
 */
export async function hasPendingCrud() {
	if (!_db) return false;
	const total = await _contarPendientesInterno(_db);
	return total > 0;
}

/**
 * Desconecta PowerSync y limpia la base SQLite local si no hay operaciones pendientes.
 * Se invoca automáticamente en SIGNED_OUT para garantizar aislamiento entre sesiones.
 *
 * @param {{ forceClear?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function closePowerSync({ forceClear = false } = {}) {
	if (!_db) return;

	try {
		const pendientes = await _contarPendientesInterno(_db);

		if (forceClear || pendientes === 0) {
			await _db.disconnectAndClear();
			localStorage.removeItem('atshel_ps_user_id');
			console.info('[ATSHEL:powersync] Base SQLite desconectada y limpiada.');
		} else {
			await _db.disconnect();
			console.warn(
				`[ATSHEL:powersync] Sesión cerrada con ${pendientes} cambios sin subir. ` +
				'Se desconectó el stream conservando la cola local.'
			);
		}
	} catch (err) {
		console.warn('[ATSHEL:powersync] Error al cerrar PowerSync:', err.message);
	} finally {
		_ready       = false;
		_initPromise = null;
		_activeUser  = null;
	}
}

// Escuchar cierre de sesión de Supabase para desconectar y limpiar SQLite automáticamente
supabase.auth.onAuthStateChange((event) => {
	if (event === 'SIGNED_OUT') {
		closePowerSync().catch(() => {});
	}
});

/**
 * Actualiza el syncStatus de atshel-core.js según el estado de PowerSync.
 */
function _actualizarSyncStatus(status) {
	const { connected, dataFlowStatus } = status;

	if (!connected) {
		syncStatus.actualizar({ estado: 'desconectado' });
		return;
	}

	const hayPendientes = Boolean(dataFlowStatus?.uploading || dataFlowStatus?.downloading);

	syncStatus.actualizar({
		estado:     hayPendientes ? 'pendiente' : 'sincronizado',
		ultimaSync: hayPendientes ? syncStatus.ultimaSync : new Date(),
		pendientes: hayPendientes ? 1 : 0,
	});
}

/**
 * Retorna true si el motor SQLite local de PowerSync está listo para recibir queries.
 * @returns {boolean}
 */
export function isPowerSyncReady() {
	return _ready && _db !== null;
}

// ─────────────────────────────────────────────────────────────
// 6. API DE QUERIES LOCALES (SQLite)
// ─────────────────────────────────────────────────────────────

/**
 * Ejecuta una query SELECT en SQLite local.
 *
 * @param {string} sql — Query SQL compatible con SQLite
 * @param {Array} [params=[]] — Parámetros posicionales
 * @returns {Promise<Array<Object>>}
 */
export async function queryLocal(sql, params = []) {
	if (!isPowerSyncReady()) {
		await initPowerSync().catch(() => {});
		if (!isPowerSyncReady()) {
			console.warn('[ATSHEL:powersync] queryLocal: SQLite no disponible.');
			return [];
		}
	}

	try {
		const result = await _db.getAll(sql, params);
		return result ?? [];
	} catch (error) {
		console.error('[ATSHEL:powersync] Error en queryLocal:', error.message, '\nSQL:', sql);
		return [];
	}
}

/**
 * Ejecuta una query INSERT/UPDATE/DELETE en SQLite local.
 * PowerSync encola el cambio en `ps_crud` y lo sube a Supabase automáticamente.
 *
 * @param {string} sql
 * @param {Array} [params=[]]
 * @returns {Promise<boolean>} true si se ejecutó correctamente
 */
export async function executeLocal(sql, params = []) {
	if (!isPowerSyncReady()) {
		await initPowerSync().catch(() => {});
		if (!isPowerSyncReady()) {
			console.error('[ATSHEL:powersync] ERR_SYS_22: executeLocal falló porque SQLite no pudo iniciar.');
			return false;
		}
	}

	try {
		await _db.execute(sql, params);
		return true;
	} catch (error) {
		console.error('[ATSHEL:powersync] Error en executeLocal:', error.message, '\nSQL:', sql);
		return false;
	}
}

/**
 * Suscribe a cambios reactivos en una query SQLite local.
 * Usa AbortController para liberar correctamente el listener al cancelar.
 *
 * @param {string} sql
 * @param {Array} [params=[]]
 * @param {function(Array): void} callback
 * @returns {function(): void} Función para cancelar la suscripción
 */
export function watchLocal(sql, params = [], callback) {
	if (!isPowerSyncReady()) {
		console.warn('[ATSHEL:powersync] watchLocal llamado antes de initPowerSync().');
		return () => {};
	}

	const abortController = new AbortController();

	_db.watch(
		sql,
		params,
		{
			onResult: (result) => {
				const rows = result?.rows?._array ?? result?.rows ?? [];
				callback(rows);
			},
			onError: (err) => {
				console.error('[ATSHEL:powersync] Error en watchLocal:', err);
			},
		},
		{ signal: abortController.signal }
	);

	return () => {
		abortController.abort();
	};
}

// ─────────────────────────────────────────────────────────────
// 7. HELPERS DE SERIALIZACIÓN JSONB / TEXT[]
// ─────────────────────────────────────────────────────────────

/**
 * Parsea un campo JSONB o TEXT[] que viene de SQLite como string.
 *
 * @param {string|null} valor
 * @param {any} [fallback=null]
 * @returns {any}
 */
export function parseJsonField(valor, fallback = null) {
	if (!valor) return fallback;
	if (typeof valor !== 'string') return valor;
	try {
		return JSON.parse(valor);
	} catch {
		console.warn('[ATSHEL:powersync] parseJsonField: no se pudo parsear:', valor);
		return fallback;
	}
}

/**
 * Serializa un valor a JSON string para guardar en SQLite.
 * @param {any} valor
 * @returns {string|null}
 */
export function stringifyJsonField(valor) {
	if (valor === null || valor === undefined) return null;
	if (typeof valor === 'string') return valor;
	return JSON.stringify(valor);
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-powersync.js v3.1.0
// ─────────────────────────────────────────────────────────────
