/**
 * atshel-powersync.js
 * Inicialización de PowerSync para ATSHEL.
 * Schema SQLite construido columna por columna desde MCP (2026-06-14).
 *
 * SEGURIDAD:
 *   · usuarios_credenciales EXCLUIDA — contiene pin_hash (bcrypt).
 *     Si se sincroniza, el hash queda en el dispositivo y es atacable offline.
 *   · adjuntos EXCLUIDA — URLs de Storage firmadas expiran en 1h.
 *     No tiene sentido cachear URLs que van a ser inválidas.
 *   · auditoria_global, auditoria_auth, incidentes_historial,
 *     nonces_usados, notificaciones_pendientes, empresa_sequences,
 *     terminos_versiones, terminos_aceptaciones EXCLUIDAS — solo lectura
 *     online o datos de servidor que el cliente no debe tener.
 *
 * TIPOS SQLite vs PostgreSQL:
 *   · JSONB   → 'text' en SQLite. Leer con JSON.parse(). Escribir con JSON.stringify().
 *   · TEXT[]  → 'text' en SQLite. Mismo tratamiento.
 *   · UUID    → 'text' en SQLite.
 *   · NUMERIC → 'real' en SQLite.
 *   · BOOL    → 'integer' en SQLite (1 = true, 0 = false).
 *   · DATE, TIMESTAMPTZ → 'text' en SQLite (ISO 8601).
 *   · INT4    → 'integer' en SQLite.
 *
 * Dependencias:
 *   · @powersync/web ^1.0.0 (instalado via npm, importado via Vite)
 *   · atshel-supabase.js (getSession)
 *   · atshel-core.js (syncStatus)
 *
 * Exporta:
 *   · db — instancia de PowerSyncDatabase (singleton)
 *   · initPowerSync()
 *   · isPowerSyncReady()
 *   · queryLocal(sql, params)
 *   · watchLocal(sql, params, callback)
 *   · executeLocal(sql, params)
 */

import {
	PowerSyncDatabase,
	Column,
	ColumnType,
	Table,
	Schema,
	SyncStatus,
} from '@powersync/web';

import { supabase, getSession } from './atshel-supabase.js';
import { syncStatus } from './atshel-core.js';

// ─────────────────────────────────────────────────────────────
// 1. HELPERS DE COLUMNAS — abreviaciones para el schema
// ─────────────────────────────────────────────────────────────

const TEXT    = (name) => new Column({ name, type: ColumnType.TEXT });
const INT     = (name) => new Column({ name, type: ColumnType.INTEGER });
const REAL    = (name) => new Column({ name, type: ColumnType.REAL });

// ─────────────────────────────────────────────────────────────
// 2. SCHEMA SQLITE LOCAL
//    Columnas verificadas MCP columna por columna.
//    PowerSync IGNORA columnas no declaradas — declarar todas
//    las que el frontend necesita leer o escribir offline.
//
//    NOTA: 'id' es manejado automáticamente por PowerSync como PK.
//    No se declara en la lista de columnas del Schema.
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
	// PK compuesta (user_id + empresa_id) — PowerSync usa 'id' interno
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
	// fotos_urls: TEXT[] en PG → text en SQLite (JSON.parse al leer)
	// acciones_inmediatas, investigacion, factores_contribuyentes: JSONB → text
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
	// Sin deleted_at — inmutable por diseño (trigger backend)
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
	// evidencia_urls: TEXT[] → text (JSON.parse al leer)
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
	// opciones: JSONB → text
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
	// riesgos_evaluacion: JSONB → text
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
	// FK: instancia_id (NO ats_instancia_id — verificado MCP)
	ats_respuestas: new Table({
		columns: [
			TEXT('atshel_local_id'),
			TEXT('instancia_id'),           // FK correcta verificada MCP
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
	// restricciones: JSONB → text
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
// 3. CONNECTOR — Autenticación PowerSync con JWT de Supabase
// ─────────────────────────────────────────────────────────────

/**
 * Connector que usa el JWT de Supabase para autenticar PowerSync.
 * PowerSync NUNCA usa token fijo — siempre JWT firmado por Supabase Auth.
 */
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
	 * Retorna el JWT actual de Supabase + la URL del servidor PowerSync.
	 */
	async fetchCredentials() {
		const session = await getSession();

		if (!session) {
			throw new Error('[ATSHEL] ERR_SYS_11: Sin sesión activa para PowerSync.');
		}

		// Si el token está próximo a expirar (< 60s), forzar refresh
		const expiresAt   = session.expires_at ?? 0;
		const ahoraEnSecs = Math.floor(Date.now() / 1000);

		if (expiresAt - ahoraEnSecs < 60) {
			const { data, error } = await supabase.auth.refreshSession();
			if (error || !data.session) {
				throw new Error('[ATSHEL] ERR_SYS_21: No se pudo refrescar el token para PowerSync.');
			}
			return {
				endpoint:   this._powersyncUrl,
				token:      data.session.access_token,
				expiresAt:  new Date(data.session.expires_at * 1000),
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
	 * Se usa Supabase como destino de escritura.
	 *
	 * @param {PowerSyncDatabase} database
	 */
	async uploadData(database) {
		const transaction = await database.getNextCrudTransaction();
		if (!transaction) return;

		try {
			for (const op of transaction.crud) {
				await this._procesarOperacion(op);
			}
			await transaction.complete();

		} catch (error) {
			console.error('[ATSHEL] Error al subir datos a Supabase:', error);

			// Errores de idempotencia — operación ya procesada, marcar como completa
			if (error.message?.startsWith('IDEMPOTENT:')) {
				console.warn('[ATSHEL] Operación idempotente detectada, omitiendo:', error.message);
				await transaction.complete();
				return;
			}

			// No completar la transacción — PowerSync la reintentará
			throw error;
		}
	}

	/**
	 * Procesa una operación CRUD individual desde PowerSync.
	 * @param {{ op: string, table: string, id: string, opData: Object }} op
	 */
	async _procesarOperacion(op) {
		const { op: tipo, table, id, opData } = op;

		switch (tipo) {
			case 'PUT': {
				// INSERT o UPDATE — PowerSync usa PUT para ambos
				const { error } = await supabase
					.from(table)
					.upsert({ id, ...opData }, {
						onConflict:       'id',
						ignoreDuplicates: false,
					});

				if (error) throw new Error(error.message);
				break;
			}

			case 'PATCH': {
				// UPDATE parcial
				const { error } = await supabase
					.from(table)
					.update(opData)
					.eq('id', id);

				if (error) throw new Error(error.message);
				break;
			}

			case 'DELETE': {
				// Soft-delete — nunca DELETE físico (regla de proyecto)
				// deleted_at es la columna real, is_deleted NO existe
				const { error } = await supabase
					.from(table)
					.update({ deleted_at: new Date().toISOString() })
					.eq('id', id);

				if (error) throw new Error(error.message);
				break;
			}

			default:
				console.warn(`[ATSHEL] Operación desconocida de PowerSync: ${tipo}`);
		}
	}
}

// ─────────────────────────────────────────────────────────────
// 4. INSTANCIA SINGLETON
// ─────────────────────────────────────────────────────────────

let _db       = null;
let _ready    = false;
let _initLock = false;

/**
 * Instancia de PowerSyncDatabase. null hasta que initPowerSync() resuelva.
 * Acceder siempre después de await initPowerSync().
 */
export let db = null;

// ─────────────────────────────────────────────────────────────
// 5. INICIALIZACIÓN
// ─────────────────────────────────────────────────────────────

/**
 * Inicializa PowerSync. Idempotente — llamadas subsiguientes retornan
 * la misma instancia sin reinicializar.
 *
 * Pasos:
 *   1. Crear PowerSyncDatabase con schema y connector
 *   2. Conectar (inicia sincronización bidireccional)
 *   3. Suscribirse a cambios de estado para actualizar syncStatus
 *
 * @returns {Promise<PowerSyncDatabase>}
 */
export async function initPowerSync() {
	if (_ready && _db) return _db;

	// Evitar doble inicialización por race condition
	if (_initLock) {
		return new Promise((resolve) => {
			const interval = setInterval(() => {
				if (_ready && _db) {
					clearInterval(interval);
					resolve(_db);
				}
			}, 100);
		});
	}

	_initLock = true;

	try {
		const connector = new AtShelConnector();

		_db = new PowerSyncDatabase({
			schema:    ATSHEL_SCHEMA,
			database: {
				dbFilename: 'atshel.db',
			},
		});

		// Exportar la instancia
		db = _db;

		// Conectar al servidor PowerSync
		await _db.connect(connector);

		// Suscribirse a cambios de estado de sync
		_db.registerListener({
			statusChanged: (status) => {
				_actualizarSyncStatus(status);
			},
		});

		_ready = true;
		console.info('[ATSHEL] PowerSync inicializado correctamente.');
		return _db;

	} catch (error) {
		_initLock = false;
		console.error('[ATSHEL] Error al inicializar PowerSync:', error);
		syncStatus.actualizar({ estado: 'error' });
		throw error;
	}
}

/**
 * Actualiza el syncStatus de atshel-core.js según el estado de PowerSync.
 * @param {SyncStatus} status
 */
function _actualizarSyncStatus(status) {
	const { connected, dataFlowStatus } = status;

	if (!connected) {
		syncStatus.actualizar({ estado: 'desconectado' });
		return;
	}

	const hayPendientes = (dataFlowStatus?.uploading || dataFlowStatus?.downloading);

	syncStatus.actualizar({
		estado:    hayPendientes ? 'pendiente' : 'sincronizado',
		ultimaSync: hayPendientes ? syncStatus.ultimaSync : new Date(),
		pendientes: hayPendientes ? 1 : 0,
	});
}

/**
 * Retorna true si PowerSync está inicializado y conectado.
 * @returns {boolean}
 */
export function isPowerSyncReady() {
	return _ready && _db !== null;
}

// ─────────────────────────────────────────────────────────────
// 6. API DE QUERIES — wrappers con fallback a Supabase
//    Si PowerSync no está listo (primer arranque, sin OPFS),
//    las queries caen a Supabase directamente.
// ─────────────────────────────────────────────────────────────

/**
 * Ejecuta una query SELECT en SQLite local.
 * Si PowerSync no está listo, retorna array vacío (el caller debe
 * decidir si hace fallback a Supabase).
 *
 * @param {string} sql — Query SQL compatible con SQLite
 * @param {Array} params — Parámetros posicionales
 * @returns {Promise<Array<Object>>}
 */
export async function queryLocal(sql, params = []) {
	if (!isPowerSyncReady()) {
		console.warn('[ATSHEL] queryLocal llamado antes de initPowerSync(). Retornando vacío.');
		return [];
	}

	try {
		const result = await _db.getAll(sql, params);
		return result ?? [];
	} catch (error) {
		console.error('[ATSHEL] Error en queryLocal:', error.message, '\nSQL:', sql);
		return [];
	}
}

/**
 * Ejecuta una query INSERT/UPDATE en SQLite local.
 * PowerSync sincroniza el cambio al backend automáticamente.
 *
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<boolean>} true si se ejecutó correctamente
 */
export async function executeLocal(sql, params = []) {
	if (!isPowerSyncReady()) {
		console.error('[ATSHEL] ERR_SYS_22: executeLocal llamado antes de initPowerSync().');
		return false;
	}

	try {
		await _db.execute(sql, params);
		return true;
	} catch (error) {
		console.error('[ATSHEL] Error en executeLocal:', error.message, '\nSQL:', sql);
		return false;
	}
}

/**
 * Suscribe a cambios en una query. Llama a callback cada vez que
 * los resultados cambian (por sync o por write local).
 *
 * @param {string} sql
 * @param {Array} params
 * @param {function(Array): void} callback
 * @returns {function} Función para cancelar la suscripción
 */
export function watchLocal(sql, params = [], callback) {
	if (!isPowerSyncReady()) {
		console.warn('[ATSHEL] watchLocal llamado antes de initPowerSync().');
		return () => {};
	}

	const watcher = _db.watch(sql, params, {
		onResult: (result) => {
			callback(result.rows?._array ?? []);
		},
	});

	// Retornar función de cancelación
	return () => {
		watcher?.cancel?.();
	};
}

// ─────────────────────────────────────────────────────────────
// 7. HELPERS DE SERIALIZACIÓN JSONB / TEXT[]
//    PostgreSQL JSONB y TEXT[] se almacenan como text en SQLite.
//    Usar estas funciones para evitar bugs silenciosos.
// ─────────────────────────────────────────────────────────────

/**
 * Parsea un campo JSONB o TEXT[] que viene de SQLite como string.
 * Retorna el valor parseado o el fallback si falla.
 *
 * @param {string|null} valor
 * @param {any} fallback — Default si el string es null o inválido
 * @returns {any}
 */
export function parseJsonField(valor, fallback = null) {
	if (!valor) return fallback;
	try {
		return JSON.parse(valor);
	} catch {
		console.warn('[ATSHEL] parseJsonField: no se pudo parsear:', valor);
		return fallback;
	}
}

/**
 * Serializa un valor a JSON string para guardar en SQLite.
 * @param {any} valor
 * @returns {string}
 */
export function stringifyJsonField(valor) {
	if (valor === null || valor === undefined) return null;
	if (typeof valor === 'string') return valor; // Ya serializado
	return JSON.stringify(valor);
}

// ─────────────────────────────────────────────────────────────
// FIN DE atshel-powersync.js
// ─────────────────────────────────────────────────────────────
